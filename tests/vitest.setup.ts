// Prevents real Qdrant connections in unit tests; vector tests inject their own store via __setVectorStoreForTests.
process.env.VECTOR_STORE ??= 'none';
