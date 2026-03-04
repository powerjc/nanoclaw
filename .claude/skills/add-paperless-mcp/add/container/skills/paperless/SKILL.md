---
name: paperless
description: Search, retrieve, upload, and manage documents in Paperless-ngx. Use whenever the user asks about documents, invoices, receipts, letters, or anything that might be filed in Paperless.
allowed-tools: Bash(curl:*)
---

# Paperless-ngx Document Management

Credentials are available as environment variables: `$PAPERLESS_URL` and `$PAPERLESS_TOKEN`.

Base URL: `$PAPERLESS_URL/api`
Auth header: `Authorization: Token $PAPERLESS_TOKEN`

## Search documents

```bash
# Search by title, content, or tags
curl -s "$PAPERLESS_URL/api/documents/?query=invoice&page_size=10" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, title, created, tags}'

# Filter by correspondent
curl -s "$PAPERLESS_URL/api/documents/?correspondent__name=Amazon" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, title, created}'

# Filter by tag name
curl -s "$PAPERLESS_URL/api/documents/?tags__name=receipt" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, title, created}'
```

## Get document details

```bash
# Get full metadata for a document
curl -s "$PAPERLESS_URL/api/documents/{id}/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '{id, title, created, correspondent, tags, document_type}'
```

## Summarize a document (fetch content)

```bash
# Get the plain text content extracted by Paperless
curl -s "$PAPERLESS_URL/api/documents/{id}/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq -r '.content' | head -200
```

## Upload a document

```bash
# Upload from a local file path
curl -s -X POST "$PAPERLESS_URL/api/documents/post_document/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" \
  -F "document=@/path/to/file.pdf" \
  -F "title=My Document"
```

## Edit metadata

```bash
# Update title, correspondent, tags, document_type
curl -s -X PATCH "$PAPERLESS_URL/api/documents/{id}/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "New Title"}'

# Add a tag (get tag IDs first)
curl -s "$PAPERLESS_URL/api/tags/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, name}'

# Assign tags (replaces all existing tags)
curl -s -X PATCH "$PAPERLESS_URL/api/documents/{id}/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tags": [1, 5, 12]}'
```

## List correspondents / tags / document types

```bash
curl -s "$PAPERLESS_URL/api/correspondents/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, name}'

curl -s "$PAPERLESS_URL/api/tags/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, name}'

curl -s "$PAPERLESS_URL/api/document_types/" \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq '.results[] | {id, name}'
```

## Tips

- `jq` is available in the container
- Pagination: use `?page=2&page_size=25` for large result sets
- Date format: `YYYY-MM-DD` (e.g. `?created__date__gte=2024-01-01`)
- Full-text search uses `?query=` and searches title + content
- Document IDs are stable integers — safe to reference across calls
