export interface Check {
  name: string;
  run: () => void | Promise<void>;
}
