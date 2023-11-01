export default class Timer {
  // store timers in state property
  private state: {
    [label: string]: { startTime: number; elapsedTime: number; called: number };
  } = {};

  // allow labels categorized by ":" character to start and stop parent timers
  // eg: "fetching:txs" will start and stop both "fetching" and "fetching:txs"
  private expandLabel(label: string) {
    const labels = label.split(':');
    return labels.map((label, index) => {
      return [...labels.slice(0, index), label].join(':');
    });
  }

  // return labelled elapsed times sorted by labels
  getAll() {
    return Object.entries(this.state)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, { elapsedTime, called }]) => ({
        label,
        elapsedTime,
        called,
      }));
  }

  // get timer
  get(label: string): number | undefined {
    return this.state[label]?.elapsedTime;
  }

  // start timer(s)
  start(label: string) {
    const now = performance.now();
    this.expandLabel(label).forEach((label) => {
      // initialize new labels if needed
      this.state[label] = this.state[label] || {
        startTime: 0,
        elapsedTime: 0,
        called: 0,
      };
      // set starting time
      this.state[label].startTime = now;
      // increment called times
      this.state[label].called += 1;
    });
    // return handy stop callback
    return () => this.stop(label);
  }

  // stop timer(s)
  stop(label: string) {
    const now = performance.now();
    this.expandLabel(label).forEach((label) => {
      // increment elapsed time
      this.state[label].elapsedTime += now - this.state[label].startTime;
      // reset timers in case this is called again
      this.state[label].startTime = now;
    });
  }

  // reset timer(s)
  reset(label: string) {
    // don't expand labels for reset timers, it would wipe out parent timers
    this.state[label] = { startTime: 0, elapsedTime: 0, called: 0 };
  }

  // remove timer(s)
  remove(label: string) {
    // don't expand labels for remove timers, it would wipe out parent timers
    delete this.state[label];
  }
}
