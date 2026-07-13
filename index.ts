#!/usr/bin/env bun

import { main } from "./scripts/loopship.ts";

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
