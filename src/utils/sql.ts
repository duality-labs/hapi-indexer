import { SimpleColumnType } from '@clickhouse/client';
import originalSQL, { Sql as OriginalSQL } from 'sql-template-tag';

type ExplicitFieldValue = { type: SimpleColumnType; value: unknown };
type FieldValue = number | string | ExplicitFieldValue;
export type Sql = Omit<OriginalSQL, 'values'> & {
  values: FieldValue[];
};
export default function sql(
  strings: TemplateStringsArray,
  ...values: (FieldValue | OriginalSQL)[]
): Sql {
  return originalSQL(strings, ...values) as Sql;
}

export function toClickHouseSQL({ sql, values }: OriginalSQL): {
  query: string;
  query_params: Record<string, unknown>;
} {
  // assume that question marks aren't part of valid SQL
  const strings = sql.split('?');
  return Array.from(strings).reduce<{
    query: string;
    query_params: Record<string, unknown>;
  }>(
    (result, string, i) => {
      const field: ExplicitFieldValue | { type: 'sql'; value: Sql } =
        typeof values[i] === 'object'
          ? (values[i] as ExplicitFieldValue)
          : typeof values[i] === 'number'
          ? { type: 'Int32', value: values[i] }
          : { type: 'String', value: values[i] };
      if (field.value !== undefined) {
        const label = `val${i + 1}`;
        return {
          query: result.query + string + `{${label}: ${field.type}}`,
          query_params: { ...result.query_params, [label]: field.value },
        };
      } else {
        return {
          query: result.query + string,
          query_params: result.query_params,
        };
      }
    },
    { query: '', query_params: {} }
  );
}
