// The gateway dispatches requests serially on each socket. Do not fill that lane
// with off-screen work while React is restoring the route and split panes.
type Priority = 'visible' | 'background'

const visible: Array<() => Promise<void>> = []
const background: Array<() => Promise<void>> = []
let routed = 0
let running = false
let scheduled = false

function drain(): void {
  if (running || scheduled || routed || (!visible.length && !background.length)) {
    return
  }

  scheduled = true
  // Let the route and the visible pane effects declare their work first.
  setTimeout(() => {
    scheduled = false

    if (routed) {
      return
    }

    const run = visible.shift() ?? background.shift()

    if (run) {
      running = true
      void run().finally(() => {
        running = false
        drain()
      })
    }
  }, 0)
}

export function queueSessionRestore<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = priority === 'visible' ? visible : background
    queue.push(() => Promise.resolve().then(run).then(resolve, reject))
    drain()
  })
}

/** Keep the primary route's synchronous selection/intent hand-off. It must
 * not wait for a background request if the user navigates after it was sent. */
export async function withRoutedSessionRestore<T>(run: () => Promise<T>): Promise<T> {
  routed += 1

  try {
    return await run()
  } finally {
    routed -= 1
    drain()
  }
}
