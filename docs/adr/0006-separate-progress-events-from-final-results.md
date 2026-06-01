# Separate progress events from final results

The gateway will publish progress events separately from final results. The TypeScript API uses an event callback, while the JSON CLI writes JSONL events to stderr and emits the final JSON result to stdout. Final results omit the accumulated event list by default to keep long Agent runs bounded; consumers may explicitly request embedded events when needed.
