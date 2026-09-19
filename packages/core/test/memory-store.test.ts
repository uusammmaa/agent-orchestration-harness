import { MemoryStore } from "../src/store/memory";
import { runStoreContract } from "./store-contract";

runStoreContract({
  name: "MemoryStore",
  async create() {
    return new MemoryStore();
  },
  async reset(store) {
    // A fresh store per test is cheaper than truncating, and equivalent.
    await store.close();
  },
});
