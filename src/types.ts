export interface Job<T extends Record<string, any> = {}> {
    jobId: number;
    job: T;
  }
  