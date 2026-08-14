/**
 * Behavioral test for the buzz adapter. Fakes the `ws` transport (nostr-tools/
 * relay assigns ws.onopen/onmessage/onerror/onclose as plain properties, never
 * .on()/.addEventListener() — the fake exposes matching simulate*() helpers
 * instead of an EventEmitter) and exercises the real (unmocked) nostr-tools
 * library against it, same spirit as signal.test.ts's fake node:net socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { message?: string }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: unknown[][] = [];

  constructor(public url: string) {
    fakeSockets.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  simulateError(): void {
    this.onerror?.(new Error('fake connection error'));
  }

  /** Last frame of the given wire type (e.g. 'AUTH', 'EVENT', 'REQ'), or undefined. */
  lastFrame(type: string): unknown[] | undefined {
    return [...this.sent].reverse().find((f) => f[0] === type);
  }

  /** First REQ frame whose filter's `kinds[0]` matches, and its subscription id. */
  reqFor(kind: number): { subId: string; frame: unknown[] } | undefined {
    const frame = this.sent.find((f) => f[0] === 'REQ' && (f[2] as { kinds?: number[] })?.kinds?.[0] === kind);
    return frame ? { subId: frame[1] as string, frame } : undefined;
  }
}

let fakeSockets: FakeWebSocket[] = [];
let createdAdapters: ChannelAdapter[] = [];

vi.mock('ws', () => ({ default: FakeWebSocket }));

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Poll a condition without vitest fake timers (the adapter's own AUTH_POLL_MS
 *  retry loop needs real timers running underneath it). */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createConfig(): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
}

const TEST_SECRET_KEY = generateSecretKey();
const TEST_PUBKEY = getPublicKey(TEST_SECRET_KEY);
const OTHER_SECRET_KEY = generateSecretKey();
const OTHER_PUBKEY = getPublicKey(OTHER_SECRET_KEY);
const GROUP_ID = 'test-group-uuid';

function groupMetadataEvent(id: string, name: string) {
  return finalizeEvent(
    {
      kind: 39000,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', id],
        ['name', name],
      ],
      content: '',
    },
    OTHER_SECRET_KEY,
  );
}

function groupMembersEvent(id: string, memberPubkeys: string[]) {
  return finalizeEvent(
    {
      kind: 39002,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', id], ...memberPubkeys.map((p) => ['p', p])],
      content: '',
    },
    OTHER_SECRET_KEY,
  );
}

function channelMessageEvent(content: string, extraTags: string[][] = [], signer = OTHER_SECRET_KEY) {
  return finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [['h', GROUP_ID], ...extraTags], content },
    signer,
  );
}

/** Imports the (freshly-reset) buzz module and builds an adapter instance via
 *  its registered factory — mirrors what channel-registry.ts does at boot.
 *  BUZZ_INSTANCES is set to a single "test" instance in beforeEach, so
 *  registerBuzzInstances() makes exactly one registerChannelAdapter call
 *  ('buzz-test') and .at(-1) unambiguously grabs it. */
async function createTestAdapter(): Promise<ChannelAdapter> {
  await import('./buzz.js'); // side-effecting: runs registerBuzzInstances()
  const registerMock = (await import('./channel-registry.js')).registerChannelAdapter as ReturnType<typeof vi.fn>;
  const registration = registerMock.mock.calls.at(-1)?.[1];
  const adapter = registration.factory() as ChannelAdapter;
  createdAdapters.push(adapter);
  return adapter;
}

/** Drives setup() through connect -> auth -> group discovery (one group, we're a
 *  member) -> subscribe, using the real nostr-tools/relay code against the fake
 *  socket. Returns the socket and the adapter once setup() has resolved. */
async function bootstrapConnectedAdapter(
  config: ChannelSetup,
): Promise<{ adapter: ChannelAdapter; socket: FakeWebSocket }> {
  const adapter = await createTestAdapter();

  const setupPromise = adapter.setup(config);
  await waitFor(() => fakeSockets.length > 0);
  const socket = fakeSockets[0];
  socket.simulateOpen();

  // Relay proactively sends the AUTH challenge; our reactive onauth handler
  // (plus the setup()-side waitForAuth retry loop) answers it.
  socket.simulateMessage(['AUTH', 'challenge-123']);
  await waitFor(() => socket.lastFrame('AUTH') !== undefined);
  const authFrame = socket.lastFrame('AUTH') as [string, { id: string }];
  socket.simulateMessage(['OK', authFrame[1].id, true, '']);

  // Group discovery: kind 39000
  await waitFor(() => socket.reqFor(39000) !== undefined);
  const discovery = socket.reqFor(39000)!;
  socket.simulateMessage(['EVENT', discovery.subId, groupMetadataEvent(GROUP_ID, 'Test Group')]);
  socket.simulateMessage(['EOSE', discovery.subId]);

  // Membership check: kind 39002
  await waitFor(() => socket.reqFor(39002) !== undefined);
  const members = socket.reqFor(39002)!;
  socket.simulateMessage(['EVENT', members.subId, groupMembersEvent(GROUP_ID, [TEST_PUBKEY, OTHER_PUBKEY])]);
  socket.simulateMessage(['EOSE', members.subId]);

  await setupPromise;
  await flush();
  return { adapter, socket };
}

/** Waits for the next real inbound-poll cycle (INBOUND_POLL_MS in buzz.ts —
 *  inbound delivery is polled, not a live subscription; see that file's
 *  header comment for why) and answers it with a single event. */
async function deliverViaPoll(socket: FakeWebSocket, event: ReturnType<typeof channelMessageEvent>): Promise<void> {
  const before = socket.sent.filter((f) => f[0] === 'REQ' && (f[2] as { kinds?: number[] })?.kinds?.[0] === 9).length;
  await waitFor(
    () => socket.sent.filter((f) => f[0] === 'REQ' && (f[2] as { kinds?: number[] })?.kinds?.[0] === 9).length > before,
    12_000,
  );
  const polls = socket.sent.filter((f) => f[0] === 'REQ' && (f[2] as { kinds?: number[] })?.kinds?.[0] === 9);
  const subId = polls[polls.length - 1][1] as string;
  socket.simulateMessage(['EVENT', subId, event]);
  socket.simulateMessage(['EOSE', subId]);
  await flush();
}

beforeEach(() => {
  fakeSockets = [];
  createdAdapters = [];
  vi.resetModules();
  process.env.BUZZ_RELAY_URL = 'ws://fake-relay:3000';
  process.env.BUZZ_INSTANCES = 'test';
  process.env.BUZZ_NSEC_TEST = nsecEncode(TEST_SECRET_KEY);
});

afterEach(async () => {
  for (const adapter of createdAdapters) await adapter.teardown();
});

describe('buzz channel adapter', () => {
  it('registers one instance per BUZZ_INSTANCES entry via registerChannelAdapter', async () => {
    await import('./buzz.js');
    const registerMock = (await import('./channel-registry.js')).registerChannelAdapter as ReturnType<typeof vi.fn>;
    expect(registerMock).toHaveBeenCalledWith('buzz-test', expect.objectContaining({ defaults: expect.any(Object) }));
  });

  it('completes the NIP-42 auth handshake and reports connected', async () => {
    const { adapter } = await bootstrapConnectedAdapter(createConfig());
    expect(adapter.isConnected()).toBe(true);
  });

  it('discovers only groups it is a member of, and reports them via onMetadata', async () => {
    const config = createConfig();
    await bootstrapConnectedAdapter(config);
    expect(config.onMetadata).toHaveBeenCalledTimes(1);
    expect(config.onMetadata).toHaveBeenCalledWith(`buzz:${GROUP_ID}`, 'Test Group', true);
  });

  it('throws a NetworkError when the relay connection fails', async () => {
    const adapter = await createTestAdapter();
    const setupPromise = adapter.setup(createConfig());
    await waitFor(() => fakeSockets.length > 0);
    fakeSockets[0].simulateError();

    await expect(setupPromise).rejects.toMatchObject({ name: 'NetworkError' });
  });

  it("does not call onInbound for the adapter identity's own posts (echo skip)", async () => {
    const config = createConfig();
    const { socket } = await bootstrapConnectedAdapter(config);

    await deliverViaPoll(socket, channelMessageEvent('hello from myself', [], TEST_SECRET_KEY));

    expect(config.onInbound).not.toHaveBeenCalled();
  }, 15_000);

  it('calls onInbound with isMention=true when a p-tag names our pubkey', async () => {
    const config = createConfig();
    const { socket } = await bootstrapConnectedAdapter(config);

    await deliverViaPoll(socket, channelMessageEvent('hey buzz', [['p', TEST_PUBKEY]]));

    expect(config.onInbound).toHaveBeenCalledWith(
      `buzz:${GROUP_ID}`,
      null,
      expect.objectContaining({ isMention: true, isGroup: true }),
    );
  }, 15_000);

  it('calls onInbound with isMention=undefined when no p-tag names our pubkey', async () => {
    const config = createConfig();
    const { socket } = await bootstrapConnectedAdapter(config);

    await deliverViaPoll(socket, channelMessageEvent('just chatting'));

    expect(config.onInbound).toHaveBeenCalledWith(
      `buzz:${GROUP_ID}`,
      null,
      expect.objectContaining({ isMention: undefined }),
    );
  }, 15_000);

  it('deliver() publishes a correctly-shaped kind:9 EVENT and resolves to the event id on OK', async () => {
    const { adapter, socket } = await bootstrapConnectedAdapter(createConfig());

    const deliverPromise = adapter.deliver(`buzz:${GROUP_ID}`, null, {
      kind: 'chat',
      content: { text: 'hello group' },
    });
    await waitFor(() => socket.lastFrame('EVENT') !== undefined);
    const eventFrame = socket.lastFrame('EVENT') as [
      string,
      { id: string; kind: number; tags: string[][]; content: string },
    ];
    expect(eventFrame[1].kind).toBe(9);
    expect(eventFrame[1].tags).toContainEqual(['h', GROUP_ID]);
    expect(eventFrame[1].content).toBe('hello group');

    socket.simulateMessage(['OK', eventFrame[1].id, true, '']);
    await expect(deliverPromise).resolves.toBe(eventFrame[1].id);
  });
});
