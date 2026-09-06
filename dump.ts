// Podglad stanu KV:  deno task dump
import { renderDump } from './src/report.ts';

console.log(await renderDump());
