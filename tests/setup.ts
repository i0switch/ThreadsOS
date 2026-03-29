// Vitest global test setup
// This file runs before all tests

import { afterAll, beforeAll } from "vitest";

beforeAll(() => {
  // Set test environment variables
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = ":memory:";
});

afterAll(() => {
  // Cleanup after all tests
});
