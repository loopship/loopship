#!/usr/bin/env node

import { main } from "./scripts/loopo.ts";

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
