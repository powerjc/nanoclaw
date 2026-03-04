/**
 * Sonarr / Radarr MCP Server
 *
 * Compiled alongside agent-runner and launched as a child process by the SDK.
 * Configuration via environment variables (injected from .env via settings.json):
 *   SONARR_URL      - Base URL (e.g. https://sonarr.example.com)
 *   SONARR_API_KEY  - API key
 *   RADARR_URL      - Base URL (e.g. https://radarr.example.com)
 *   RADARR_API_KEY  - API key
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SONARR_URL = process.env.SONARR_URL?.replace(/\/$/, '');
const SONARR_API_KEY = process.env.SONARR_API_KEY;
const RADARR_URL = process.env.RADARR_URL?.replace(/\/$/, '');
const RADARR_API_KEY = process.env.RADARR_API_KEY;

// --- API helpers ---

async function apiRequest(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: object,
): Promise<unknown> {
  const url = `${baseUrl}/api/v3${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 && text.toLowerCase().includes('already')) throw new Error('already exists');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 204 || !ct.includes('application/json')) return null;
  return res.json();
}

function sonarrApi(method: string, path: string, body?: object): Promise<unknown> {
  if (!SONARR_URL || !SONARR_API_KEY) throw new Error('Sonarr not configured. Set SONARR_URL and SONARR_API_KEY in .env.');
  return apiRequest(SONARR_URL, SONARR_API_KEY, method, path, body);
}

function radarrApi(method: string, path: string, body?: object): Promise<unknown> {
  if (!RADARR_URL || !RADARR_API_KEY) throw new Error('Radarr not configured. Set RADARR_URL and RADARR_API_KEY in .env.');
  return apiRequest(RADARR_URL, RADARR_API_KEY, method, path, body);
}

type Row = Record<string, unknown>;

function ok(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function fail(text: string) { return { content: [{ type: 'text' as const, text }], isError: true as const }; }
function wrap(fn: () => Promise<ReturnType<typeof ok>>) {
  return fn().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
}

// --- MCP server ---

const server = new McpServer({ name: 'sonarr-radarr', version: '1.0.0' });

// Sonarr

server.tool('sonarr_search_series', 'Search for TV shows by name', {
  query: z.string().describe('Show name to search for'),
}, ({ query }) => wrap(async () => {
  const results = await sonarrApi('GET', `/series/lookup?term=${encodeURIComponent(query)}`) as Row[];
  if (!results?.length) return ok('No results found.');
  return ok(`Found ${results.length} result(s):\n` + results.slice(0, 8).map((s) =>
    `- [tvdbId: ${s['tvdbId']}] ${s['title']} (${s['year'] ?? 'N/A'})${s['overview'] ? ': ' + String(s['overview']).slice(0, 120) + '...' : ''}`,
  ).join('\n'));
}));

server.tool('sonarr_get_quality_profiles', 'List available Sonarr quality profiles', {}, () => wrap(async () => {
  const profiles = await sonarrApi('GET', '/qualityProfile') as Row[];
  return ok('Quality profiles:\n' + profiles.map((p) => `- [${p['id']}] ${p['name']}`).join('\n'));
}));

server.tool('sonarr_get_root_folders', 'List available Sonarr root folders', {}, () => wrap(async () => {
  const folders = await sonarrApi('GET', '/rootFolder') as Row[];
  return ok('Root folders:\n' + folders.map((f) => {
    const gb = f['freeSpace'] ? Math.round(Number(f['freeSpace']) / 1e9) + 'GB free' : 'unknown space';
    return `- ${f['path']} (${gb})`;
  }).join('\n'));
}));

server.tool('sonarr_add_series', 'Add a TV series to Sonarr for monitoring and downloading', {
  tvdb_id: z.number().int().describe('TVDB ID from sonarr_search_series'),
  quality_profile: z.string().default('Any').describe('Quality profile name (use sonarr_get_quality_profiles)'),
  root_folder: z.string().optional().describe('Root folder path prefix (use sonarr_get_root_folders; defaults to first)'),
  monitor: z.enum(['all', 'future', 'missing', 'existing', 'firstSeason', 'latestSeason']).default('all'),
}, ({ tvdb_id, quality_profile, root_folder, monitor }) => wrap(async () => {
  const [profiles, rootFolders, lookup] = await Promise.all([
    sonarrApi('GET', '/qualityProfile') as Promise<Row[]>,
    sonarrApi('GET', '/rootFolder') as Promise<Row[]>,
    sonarrApi('GET', `/series/lookup?term=tvdb:${tvdb_id}`) as Promise<Row[]>,
  ]);
  if (!lookup?.length) return fail(`No series found with tvdbId ${tvdb_id}.`);
  const profile = profiles.find((p) => String(p['name']).toLowerCase() === quality_profile.toLowerCase()) ?? profiles[0];
  if (!profile) return fail('No quality profiles available.');
  const folder = root_folder ? rootFolders.find((f) => String(f['path']).startsWith(root_folder)) : rootFolders[0];
  if (!folder) return fail(`Root folder not found: ${root_folder}`);
  const result = await sonarrApi('POST', '/series', {
    ...lookup[0], qualityProfileId: profile['id'], rootFolderPath: folder['path'],
    monitored: true, addOptions: { monitor, searchForMissingEpisodes: true },
  }) as Row;
  return ok(`Added "${result['title']}" (${result['year']}) to Sonarr. ID: ${result['id']}. Profile: ${profile['name']}, Folder: ${folder['path']}.`);
}));

server.tool('sonarr_list_series', 'List all TV series in Sonarr', {}, () => wrap(async () => {
  const series = await sonarrApi('GET', '/series') as Row[];
  if (!series?.length) return ok('No series in Sonarr.');
  return ok(`${series.length} series:\n` + series.map((s) => {
    const st = s['statistics'] as Record<string, number> | undefined;
    return `- [${s['id']}] ${s['title']} (${s['year']}) — ${s['monitored'] ? 'monitored' : 'unmonitored'}, ${st?.['episodeFileCount'] ?? 0}/${st?.['totalEpisodeCount'] ?? '?'} eps`;
  }).join('\n'));
}));

server.tool('sonarr_get_series', 'Get detailed info about a specific series', {
  series_id: z.number().int().describe('Sonarr series ID'),
}, ({ series_id }) => wrap(async () => {
  const s = await sonarrApi('GET', `/series/${series_id}`) as Row;
  const seasons = (s['seasons'] as Row[] ?? []).map((season) => {
    const st = season['statistics'] as Record<string, number> | undefined;
    return `  Season ${season['seasonNumber']}: ${st?.['episodeFileCount'] ?? 0}/${st?.['totalEpisodeCount'] ?? '?'} eps`;
  });
  return ok(`${s['title']} (${s['year']})\nStatus: ${s['status']}\nMonitored: ${s['monitored']}\nNetwork: ${s['network'] ?? 'N/A'}\nOverview: ${String(s['overview'] ?? 'N/A').slice(0, 200)}\n\nSeasons:\n${seasons.join('\n')}`);
}));

server.tool('sonarr_delete_series', 'Remove a series from Sonarr', {
  series_id: z.number().int().describe('Sonarr series ID'),
  delete_files: z.boolean().default(false).describe('Also delete downloaded files from disk'),
}, ({ series_id, delete_files }) => wrap(async () => {
  await sonarrApi('DELETE', `/series/${series_id}?deleteFiles=${delete_files}`);
  return ok(`Series ${series_id} removed from Sonarr${delete_files ? ' and files deleted' : ''}.`);
}));

// Radarr

server.tool('radarr_search_movie', 'Search for movies by name', {
  query: z.string().describe('Movie name to search for'),
}, ({ query }) => wrap(async () => {
  const results = await radarrApi('GET', `/movie/lookup?term=${encodeURIComponent(query)}`) as Row[];
  if (!results?.length) return ok('No results found.');
  return ok(`Found ${results.length} result(s):\n` + results.slice(0, 8).map((m) =>
    `- [tmdbId: ${m['tmdbId']}] ${m['title']} (${m['year'] ?? 'N/A'})${m['overview'] ? ': ' + String(m['overview']).slice(0, 120) + '...' : ''}`,
  ).join('\n'));
}));

server.tool('radarr_get_quality_profiles', 'List available Radarr quality profiles', {}, () => wrap(async () => {
  const profiles = await radarrApi('GET', '/qualityProfile') as Row[];
  return ok('Quality profiles:\n' + profiles.map((p) => `- [${p['id']}] ${p['name']}`).join('\n'));
}));

server.tool('radarr_get_root_folders', 'List available Radarr root folders', {}, () => wrap(async () => {
  const folders = await radarrApi('GET', '/rootFolder') as Row[];
  return ok('Root folders:\n' + folders.map((f) => `- ${f['path']}`).join('\n'));
}));

server.tool('radarr_add_movie', 'Add a movie to Radarr for monitoring and downloading', {
  tmdb_id: z.number().int().describe('TMDB ID from radarr_search_movie'),
  quality_profile: z.string().default('Any').describe('Quality profile name (use radarr_get_quality_profiles)'),
  root_folder: z.string().optional().describe('Root folder path prefix (use radarr_get_root_folders; defaults to first)'),
  monitor: z.boolean().default(true).describe('Monitor movie and search for release immediately'),
}, ({ tmdb_id, quality_profile, root_folder, monitor }) => wrap(async () => {
  const [profiles, rootFolders, lookup] = await Promise.all([
    radarrApi('GET', '/qualityProfile') as Promise<Row[]>,
    radarrApi('GET', '/rootFolder') as Promise<Row[]>,
    radarrApi('GET', `/movie/lookup?term=tmdb:${tmdb_id}`) as Promise<Row[]>,
  ]);
  if (!lookup?.length) return fail(`No movie found with tmdbId ${tmdb_id}.`);
  const profile = profiles.find((p) => String(p['name']).toLowerCase() === quality_profile.toLowerCase()) ?? profiles[0];
  if (!profile) return fail('No quality profiles available.');
  const folder = root_folder ? rootFolders.find((f) => String(f['path']).startsWith(root_folder)) : rootFolders[0];
  if (!folder) return fail(`Root folder not found: ${root_folder}`);
  const result = await radarrApi('POST', '/movie', {
    ...lookup[0], qualityProfileId: profile['id'], rootFolderPath: folder['path'],
    monitored: monitor, addOptions: { searchForMovie: monitor },
  }) as Row;
  return ok(`Added "${result['title']}" (${result['year']}) to Radarr. ID: ${result['id']}. Profile: ${profile['name']}.`);
}));

server.tool('radarr_list_movies', 'List all movies in Radarr', {}, () => wrap(async () => {
  const movies = await radarrApi('GET', '/movie') as Row[];
  if (!movies?.length) return ok('No movies in Radarr.');
  return ok(`${movies.length} movies:\n` + movies.map((m) =>
    `- [${m['id']}] ${m['title']} (${m['year']}) — ${m['monitored'] ? 'monitored' : 'unmonitored'}${m['hasFile'] ? ', downloaded' : ''}`,
  ).join('\n'));
}));

server.tool('radarr_get_movie', 'Get detailed info about a specific movie', {
  movie_id: z.number().int().describe('Radarr movie ID'),
}, ({ movie_id }) => wrap(async () => {
  const m = await radarrApi('GET', `/movie/${movie_id}`) as Row;
  return ok(`${m['title']} (${m['year']})\nStatus: ${m['status']}\nMonitored: ${m['monitored']}\nDownloaded: ${m['hasFile']}\nStudio: ${m['studio'] ?? 'N/A'}\nOverview: ${String(m['overview'] ?? 'N/A').slice(0, 200)}`);
}));

server.tool('radarr_delete_movie', 'Remove a movie from Radarr', {
  movie_id: z.number().int().describe('Radarr movie ID'),
  delete_files: z.boolean().default(false).describe('Also delete downloaded files from disk'),
}, ({ movie_id, delete_files }) => wrap(async () => {
  await radarrApi('DELETE', `/movie/${movie_id}?deleteFiles=${delete_files}`);
  return ok(`Movie ${movie_id} removed from Radarr${delete_files ? ' and files deleted' : ''}.`);
}));

const transport = new StdioServerTransport();
await server.connect(transport);
