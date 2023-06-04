export type DataRow<T = Array<number>> = [time_unix: number, values: T];

// this function assumes the data is already sorted in any direction
// it will sum the data that matches the data's time_unix timestamp
export function accumulateDataSorted<T extends Array<number>>(
  data: Array<DataRow<T>>,
  row: DataRow<T>
): Array<DataRow<T>> {
  const lastRow = data[data.length - 1];
  // if a match is found accumulate (mutate) the values
  if (lastRow && lastRow[0] === row[0]) {
    for (let i = 0; i < lastRow[1].length; i++) {
      lastRow[1][i] += row[1][i];
    }
  }
  // add new values
  else {
    data.push(row);
  }
  return data;
}

// this function assumes the data is already sorted in a descending order
// it will get the most recent data that matches the data's time_unix timestamp
export function getLatestDataDescending<T extends Array<number>>(
  data: Array<DataRow<T>>,
  row: DataRow<T>
): Array<DataRow<T>> {
  const lastRow = data[data.length - 1];
  // if data is ordered in descending timestamp form then the first version of
  // a timestamp that is seen is the latest time in the resolved timestamp
  if (!lastRow || lastRow[0] !== row[0]) {
    data.push(row);
  }
  return data;
}
