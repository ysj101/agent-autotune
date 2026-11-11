import { readFileSync, writeFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
writeFileSync(`${process.argv[3]}/${Date.now()}-${process.argv[2]}.json`, input);
