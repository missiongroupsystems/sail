import { logger } from "../logger.js";

/**
 * The worker process (`--role=worker`): long jobs never run in request
 * transactions. Phase modules register tasks with an interval.
 */
export type WorkerTask = { name: string; intervalMs: number; run: () => Promise<void> };

const tasks: WorkerTask[] = [];
export function registerWorkerTask(task: WorkerTask) {
  tasks.push(task);
}

export async function runWorker(): Promise<() => Promise<void>> {
  const timers: NodeJS.Timeout[] = [];
  for (const task of tasks) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await task.run();
      } catch (e) {
        logger.error({ err: e, task: task.name }, "worker task failed");
      } finally {
        running = false;
      }
    };
    void tick();
    timers.push(setInterval(() => void tick(), task.intervalMs));
  }
  logger.info({ tasks: tasks.map((t) => t.name) }, "worker started");
  return async () => {
    for (const t of timers) clearInterval(t);
  };
}

/** For tests: run every registered task once. */
export async function runAllTasksOnce() {
  for (const t of tasks) await t.run();
}
export function workerTasks() {
  return tasks.map((t) => t.name);
}
