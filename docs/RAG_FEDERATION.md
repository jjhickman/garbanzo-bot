# RAG Federation

RAG federation lets one Garbanzo instance read from additional Qdrant collections at prompt time. It is for read-only knowledge bases such as runbooks, archives, or a separate instance's curated vector collection.

Federated sources are not part of shared memory. Garbanzo never writes facts, messages, summaries, or embeddings to these sources.

## Enable

Set:

```bash
RAG_FEDERATION_ENABLED=true
```

Then copy the example config:

```bash
cp config/rag-sources.example.json config/rag-sources.json
```

If federation is enabled and the sources file is missing or unreadable, startup logs a warning and continues without federation.

## Source Config

`config/rag-sources.json` has this shape:

```json
{
  "sources": [
    {
      "id": "runbooks",
      "label": "Runbooks",
      "url": "http://qdrant:6333",
      "collection": "ops_runbooks",
      "textField": "text",
      "embedding": {
        "provider": "openai",
        "model": "text-embedding-3-small",
        "dimensions": 1536
      },
      "maxHits": 3,
      "minScore": 0.35,
      "chats": ["discord-channel-id"],
      "enabled": true
    }
  ]
}
```

Fields:

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | Yes | Stable unique source id. |
| `label` | Yes | Human-readable label shown in the prompt block. |
| `url` | No | Qdrant URL. Defaults to this instance's `QDRANT_URL`. |
| `apiKey` | No | Qdrant API key for this source. Defaults to this instance's `QDRANT_API_KEY`. |
| `collection` | Yes | Qdrant collection to search. |
| `textField` | No | Payload field containing prompt text. Defaults to `text`. |
| `embedding.provider` | Yes | `openai` or `deterministic`. |
| `embedding.model` | No | Embedding model for this source. OpenAI sources default to `VECTOR_EMBEDDING_MODEL`. |
| `embedding.dimensions` | No | Embedding dimensions for this source. Defaults to `VECTOR_EMBEDDING_DIMENSIONS`. |
| `maxHits` | No | Per-source hit cap, 1-10. Defaults to `3`. |
| `minScore` | No | Minimum Qdrant score, 0-1. Defaults to `0.35`. |
| `chats` | No | Chat allowlist. Omit to allow all chats. |
| `enabled` | No | Source-level switch. Defaults to `true`. |

## Embedding Models

Each source is embedded and searched in its own vector space. Do not assume scores from two sources are comparable when their embedding providers, models, or dimensions differ.

Garbanzo embeds the user message once per eligible source using that source's configured embedding settings, then searches only that source's collection with that vector.

## Prompt Block

When enabled, Garbanzo adds a bounded block next to the regular memory/shared-facts block:

```text
Federated knowledge (read-only source hits):
  - [Runbooks] ...
```

The block is capped to keep prompts stable: up to 3 hits, 300 characters of text per line, and 1500 characters total.
