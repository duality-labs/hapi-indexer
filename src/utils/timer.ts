export default class Timer {
  // store timers in state property
  private state: {
    [label: string]: { startTime: number; elapsedTime: number };
  } = {};

  // return labelled elapsed times sorted by labels
  getAll() {
    return Object.entries(this.state)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, { elapsedTime }]) => ({ label, elapsedTime }));
  }

  // get timer
  get(label: string): number | undefined {
    return this.state[label]?.elapsedTime;
  }

  // start timer(s)
  start(...labels: string[] | string[][]) {
    labels
      .flatMap((v) => v)
      .forEach((label) => {
        // initialize new labels if needed
        this.state[label] = this.state[label] || {
          startTime: 0,
          elapsedTime: 0,
        };
        // set starting time
        this.state[label].startTime = Date.now();
      });
    // return handy stop callback
    return () => this.stop(...labels);
  }

  // stop timer(s)
  stop(...labels: string[] | string[][]) {
    labels
      .flatMap((v) => v)
      .forEach((label) => {
        // increment elapsed time
        this.state[label].elapsedTime +=
          Date.now() - this.state[label].startTime;
      });
  }

  // reset timer(s)
  reset(...labels: string[] | string[][]) {
    labels
      .flatMap((v) => v)
      .forEach((label) => {
        this.state[label] = { startTime: 0, elapsedTime: 0 };
      });
  }
}
