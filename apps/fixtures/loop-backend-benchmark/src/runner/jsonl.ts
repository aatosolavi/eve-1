export function writeJsonlRecord(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
