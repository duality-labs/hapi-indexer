import { SimpleColumnType } from '@clickhouse/client';
import { DataFormat, QueryParamsWithFormat } from '@clickhouse/client-common';
import { Sql } from 'sql-template-tag';

type ExplicitFieldValue = { type: SimpleColumnType; value: unknown };

/**
 * transform sql-template-tag sql object to ClickHouse sql object
 * @param sql output of sql function (from 'sql-template-tag')
 * @returns query in ClickHouse client.query(query) form
 * @example
 * // returns {
 * //     query: 'SELECT plus({val1: Int32}, {val2: Int32})',
 * //     query_params: { val1: 1, val2: 2 }
 * // }
 * toClickHouseSQL(sql`SELECT plus(${1},${{ type: 'Int32', value: 2 }})`)
 * @see https://clickhouse.com/docs/integrations/javascript#queries-with-parameters
 */
export function toClickHouseSQL<T extends DataFormat>(
  { sql, values }: Sql,
  format: T
): QueryParamsWithFormat<T> {
  // assume that question marks aren't part of valid SQL
  const strings = sql.split('?');
  return Array.from(strings).reduce<QueryParamsWithFormat<T>>(
    (result, string, i) => {
      const field: ExplicitFieldValue =
        typeof values[i] === 'object'
          ? (values[i] as ExplicitFieldValue)
          : typeof values[i] === 'number'
          ? // ensure numbers are not quoted
            { type: 'Int32', value: values[i] }
          : // treat everything else as strings (this also catches `undefined`)
            { type: 'String', value: values[i] };
      if (field.value !== undefined) {
        const label = `val${i + 1}`;
        return {
          ...result,
          query: result.query + string + `{${label}: ${field.type}}`,
          query_params: { ...result.query_params, [label]: field.value },
        };
      } else {
        return {
          ...result,
          query: result.query + string,
          query_params: result.query_params,
        };
      }
    },
    {
      query: '',
      query_params: {},
      format,
      // enforce read only setting on query level
      // (so that non read-only settings can be applied at client level)
      clickhouse_settings: {
        readonly: '1',
      },
    }
  );
}
