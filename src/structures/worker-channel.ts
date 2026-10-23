import type { StructureWorkerPayload, StructureWorkerReply } from './protocol';

/** Internal transport shared by the Cubiomes and data-bundle clients. Workers
 * own computation/state; this channel only correlates replies and terminates.
 */
export class WorkerChannel {
  private readonly worker: Worker;
  private readonly pending = new Map<number, {
    resolve: (reply: StructureWorkerReply) => void;
    reject: (error: Error) => void;
  }>();
  private sequence = 0;
  private failure: Error | undefined;

  constructor(url: URL, name: string) {
    this.worker = new Worker(url, { type: 'module', name });
    this.worker.onmessage = (event: MessageEvent<StructureWorkerReply>) => {
      const reply = event.data;
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      if (reply.ok) waiting.resolve(reply);
      else {
        const error = reply.name === 'RangeError' ? new RangeError(reply.message)
          : reply.name === 'TypeError' ? new TypeError(reply.message) : new Error(reply.message);
        error.name = reply.name;
        waiting.reject(error);
        if (reply.fatal) this.stop(error);
      }
    };
    this.worker.onerror = event => {
      event.preventDefault();
      this.stop(new Error(`Structure worker failed: ${event.message}`));
    };
    this.worker.onmessageerror = () => this.stop(new Error('Structure worker message could not be decoded'));
  }

  send(payload: StructureWorkerPayload, transfer: Transferable[] = []): Promise<StructureWorkerReply> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.sequence++;
    const { promise, resolve, reject } = Promise.withResolvers<StructureWorkerReply>();
    this.pending.set(id, { resolve, reject });
    try {
      this.worker.postMessage({ ...payload, id }, transfer);
    } catch (error) {
      this.pending.delete(id);
      reject(error);
    }
    return promise;
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.worker.terminate();
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }

  terminate(): void {
    this.stop(new Error('Structure worker is terminated'));
  }
}
