#!/usr/bin/env bash
# setup-chromadb.sh — Set up ChromaDB RAG pipeline on Terra
#
# What this does:
#   1. Starts ChromaDB Docker container (localhost:8000)
#   2. Creates a Python indexing script for Obsidian vault / knowledge base
#   3. Creates a query/retrieval script for OpenClaw agents
#   4. Indexes initial content if an Obsidian vault is found
#
# Prerequisites: Docker running, workspace venv has chromadb package

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $*"; }

WORKSPACE="$HOME/.openclaw/workspace"
VENV="$WORKSPACE/.venv"
RAG_DIR="$WORKSPACE/services/rag"

# ── Step 1: Start ChromaDB ─────────────────────────────────────────
start_chromadb() {
    log "Starting ChromaDB container..."
    docker compose -f "$WORKSPACE/deployments/terra/docker-compose.yml" up -d

    # Wait for health
    local retries=0
    while ! curl -sf http://localhost:8000/api/v1/heartbeat &>/dev/null; do
        retries=$((retries + 1))
        if [[ $retries -gt 30 ]]; then
            echo "ChromaDB failed to start"
            exit 1
        fi
        sleep 1
    done
    log "ChromaDB running at http://localhost:8000"
}

# ── Step 2: Create RAG service directory ───────────────────────────
create_rag_service() {
    mkdir -p "$RAG_DIR"

    log "Creating RAG indexing and query scripts..."

    # ── Indexer: reads markdown files and indexes them into ChromaDB
    cat > "$RAG_DIR/index.py" <<'PYEOF'
#!/usr/bin/env python3
"""Index markdown files into ChromaDB for RAG retrieval.

Usage:
    python3 services/rag/index.py /path/to/docs [--collection name] [--reset]

Indexes all .md files recursively. Uses local embeddings (all-MiniLM-L6-v2)
via the embeddings server at localhost:8089, or falls back to ChromaDB's
built-in embedding function.
"""
import argparse
import hashlib
import os
import sys
from pathlib import Path

import chromadb
import requests

CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))
EMBEDDINGS_URL = os.environ.get("EMBEDDINGS_URL", "http://localhost:8089/v1/embeddings")


def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Get embeddings from local server, fall back to ChromaDB default."""
    try:
        resp = requests.post(EMBEDDINGS_URL, json={
            "input": texts,
            "model": "all-MiniLM-L6-v2"
        }, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return [item["embedding"] for item in data["data"]]
    except Exception:
        return None  # Let ChromaDB handle it


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """Split text into overlapping chunks by paragraph boundaries."""
    paragraphs = text.split("\n\n")
    chunks = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) > chunk_size and current:
            chunks.append(current.strip())
            # Keep last bit for overlap
            words = current.split()
            current = " ".join(words[-overlap:]) + "\n\n" + para if overlap else para
        else:
            current = current + "\n\n" + para if current else para

    if current.strip():
        chunks.append(current.strip())

    return chunks or [text]


def index_directory(directory: str, collection_name: str, reset: bool = False):
    """Index all markdown files in directory into ChromaDB."""
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

    if reset:
        try:
            client.delete_collection(collection_name)
            print(f"Reset collection: {collection_name}")
        except Exception:
            pass

    collection = client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"}
    )

    path = Path(directory)
    md_files = list(path.rglob("*.md"))
    print(f"Found {len(md_files)} markdown files in {directory}")

    total_chunks = 0
    for md_file in md_files:
        rel_path = str(md_file.relative_to(path))
        content = md_file.read_text(errors="ignore")

        if len(content.strip()) < 50:
            continue

        chunks = chunk_text(content)
        ids = [hashlib.md5(f"{rel_path}:{i}".encode()).hexdigest() for i in range(len(chunks))]
        metadatas = [{"source": rel_path, "chunk": i, "total_chunks": len(chunks)} for i in range(len(chunks))]

        # Try local embeddings
        embeddings = get_embeddings(chunks)

        if embeddings:
            collection.upsert(ids=ids, documents=chunks, metadatas=metadatas, embeddings=embeddings)
        else:
            collection.upsert(ids=ids, documents=chunks, metadatas=metadatas)

        total_chunks += len(chunks)

    print(f"Indexed {total_chunks} chunks from {len(md_files)} files into '{collection_name}'")
    print(f"Collection size: {collection.count()} documents")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Index markdown files into ChromaDB")
    parser.add_argument("directory", help="Path to directory containing .md files")
    parser.add_argument("--collection", default="knowledge", help="Collection name (default: knowledge)")
    parser.add_argument("--reset", action="store_true", help="Delete and recreate collection")
    args = parser.parse_args()

    if not Path(args.directory).is_dir():
        print(f"Error: {args.directory} is not a directory")
        sys.exit(1)

    index_directory(args.directory, args.collection, args.reset)
PYEOF

    # ── Query: search ChromaDB and return relevant context
    cat > "$RAG_DIR/query.py" <<'PYEOF'
#!/usr/bin/env python3
"""Query ChromaDB for RAG context retrieval.

Usage:
    python3 services/rag/query.py "search query" [--collection name] [--top-k 5]

Returns the most relevant document chunks for the query.
"""
import argparse
import json
import os
import sys

import chromadb
import requests

CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))
EMBEDDINGS_URL = os.environ.get("EMBEDDINGS_URL", "http://localhost:8089/v1/embeddings")


def get_embedding(text: str) -> list[float] | None:
    """Get embedding from local server."""
    try:
        resp = requests.post(EMBEDDINGS_URL, json={
            "input": [text],
            "model": "all-MiniLM-L6-v2"
        }, timeout=10)
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]
    except Exception:
        return None


def query(text: str, collection_name: str = "knowledge", top_k: int = 5):
    """Query ChromaDB and return relevant chunks."""
    client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

    try:
        collection = client.get_collection(collection_name)
    except Exception:
        print(json.dumps({"error": f"Collection '{collection_name}' not found"}))
        sys.exit(1)

    embedding = get_embedding(text)

    if embedding:
        results = collection.query(query_embeddings=[embedding], n_results=top_k)
    else:
        results = collection.query(query_texts=[text], n_results=top_k)

    output = []
    for i, (doc, meta, dist) in enumerate(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0]
    )):
        output.append({
            "rank": i + 1,
            "source": meta.get("source", "unknown"),
            "chunk": meta.get("chunk", 0),
            "distance": round(dist, 4),
            "text": doc[:500]  # Truncate for display
        })

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Query ChromaDB for relevant context")
    parser.add_argument("query", help="Search query text")
    parser.add_argument("--collection", default="knowledge", help="Collection name")
    parser.add_argument("--top-k", type=int, default=5, help="Number of results")
    args = parser.parse_args()

    query(args.query, args.collection, args.top_k)
PYEOF

    chmod +x "$RAG_DIR/index.py" "$RAG_DIR/query.py"
    log "RAG scripts created at $RAG_DIR/"
}

# ── Step 3: Index initial content ──────────────────────────────────
index_initial_content() {
    local python="$VENV/bin/python3"
    if [[ ! -f "$python" ]]; then
        warn "Workspace venv not found at $VENV — skipping initial indexing"
        return 0
    fi

    # Index workspace docs
    if [[ -d "$WORKSPACE/docs" ]]; then
        log "Indexing workspace documentation..."
        "$python" "$RAG_DIR/index.py" "$WORKSPACE/docs" --collection docs --reset
    fi

    # Index Obsidian vault if it exists
    local obsidian_vault="$HOME/Documents/BostonCommunity"
    if [[ -d "$obsidian_vault" ]]; then
        log "Indexing Obsidian vault..."
        "$python" "$RAG_DIR/index.py" "$obsidian_vault" --collection community
    fi

    # Index skills documentation
    if [[ -d "$WORKSPACE/skills" ]]; then
        log "Indexing skill documentation..."
        "$python" "$RAG_DIR/index.py" "$WORKSPACE/skills" --collection skills
    fi
}

# ── Main ───────────────────────────────────────────────────────────
main() {
    echo -e "${BLUE}━━━ Terra: ChromaDB RAG Pipeline ━━━${NC}"
    echo ""

    start_chromadb
    create_rag_service
    index_initial_content

    echo ""
    echo -e "${BLUE}━━━ RAG Setup Complete ━━━${NC}"
    echo ""
    echo "  ChromaDB:  http://localhost:8000"
    echo "  Index:     $VENV/bin/python3 $RAG_DIR/index.py /path/to/docs --collection name"
    echo "  Query:     $VENV/bin/python3 $RAG_DIR/query.py 'search query' --collection name"
    echo ""
    echo "  Collections indexed:"
    curl -sf http://localhost:8000/api/v1/collections | python3 -m json.tool 2>/dev/null | grep '"name"' | sed 's/^/    /' || echo "    (none yet)"
    echo ""
}

main "$@"
