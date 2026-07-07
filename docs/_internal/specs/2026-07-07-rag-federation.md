# RAG Source Federation

## Goal

An instance can consult additional read-only vector sources at prompt time, alongside its own memory. Federated sources may use different embedding models and dimensions. Vector spaces are incomparable, so each source is queried with an embedding generated from that source's configured embedding provider, model, and dimensions.

Federation is read-only. Garbanzo never writes to a federated source, never creates collections for it, and does not add owner commands or AI tools in this iteration.

## Config

- `RAG_FEDERATION_ENABLED` defaults to `false`.
- When enabled and `config/rag-sources.json` is not readable, startup warns but continues.
- `config/rag-sources.json` is loaded once from `PROJECT_ROOT`, parsed with a strict Zod schema, and returns `null` instead of throwing on absent or invalid files.
- Source ids must be non-empty and unique.
- A source defines `id`, `label`, optional `url` defaulting to this instance's `QDRANT_URL`, optional `apiKey`, `collection`, `textField` defaulting to `text`, `embedding`, `maxHits` defaulting to `3`, `minScore` defaulting to `0.35`, optional `chats`, and `enabled` defaulting to `true`.

## Retrieval

`searchFederatedSources(query, chatId)` checks only enabled sources allowed for the chat. It embeds the query per source, searches a lazily constructed per-source read store, maps `payload[textField]` to result text, applies `minScore` and `maxHits`, and returns `{sourceId, label, text, score}` hits.

Errors are isolated per source. A failed source logs a warning with `sourceId` and the remaining sources still run.

## Prompt Injection

When federation is enabled, the system prompt includes a bounded block adjacent to the memory/shared-facts block:

- Up to 3 federated hits.
- Each line is formatted as `[label] text`.
- Each hit text is truncated to 300 characters.
- The full federated block is capped at 1500 characters.

With the flag disabled, prompt output remains byte-identical and no federated store is constructed.
