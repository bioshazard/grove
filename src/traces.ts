import type { Database } from "./db.ts";

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startTime: number;
  endTime?: number | null;
  attributes?: Record<string, unknown>;
  symbolId?: string | null;
}

export function insertTraces(db: Database, spans: TraceSpan[]): void {
  db.transaction(() => {
    for (const span of spans) {
      db.run(
        `INSERT INTO traces(span_id, parent_span_id, name, start_time, end_time, attributes, symbol_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(span_id) DO UPDATE SET
           parent_span_id = excluded.parent_span_id,
           name = excluded.name,
           start_time = excluded.start_time,
           end_time = excluded.end_time,
           attributes = excluded.attributes,
           symbol_id = excluded.symbol_id`,
        span.spanId,
        span.parentSpanId ?? null,
        span.name,
        span.startTime,
        span.endTime ?? null,
        JSON.stringify(span.attributes ?? {}),
        span.symbolId ?? null,
      );
    }
  });
}

export function tracesForSymbol(db: Database, symbolId: string): unknown[] {
  return db.prepare(
    `SELECT span_id AS spanId, parent_span_id AS parentSpanId, name, start_time AS startTime,
            end_time AS endTime, attributes,
            CASE WHEN end_time IS NULL THEN NULL ELSE end_time - start_time END AS durationMs
     FROM traces WHERE symbol_id = ? ORDER BY start_time DESC`,
  ).all(symbolId).map(parseAttributes);
}

export function queryTraces(db: Database, sql: string, params: unknown[] = []): unknown[] {
  if (!/^\s*(SELECT|WITH|PRAGMA\s+(table_info|index_list))/i.test(sql)) {
    throw new Error("Trace queries must be read-only SELECT/WITH statements");
  }
  return db.prepare(sql).all(...params).map(parseAttributes);
}

function parseAttributes(value: unknown): unknown {
  const row = value as Record<string, unknown>;
  if (typeof row.attributes !== "string") return row;
  return { ...row, attributes: JSON.parse(row.attributes) };
}
