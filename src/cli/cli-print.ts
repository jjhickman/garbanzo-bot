export interface CliPrinter {
  stdout(message: string): void;
  stderr(message: string): void;
}

export const processPrinter: CliPrinter = {
  stdout: (message) => {
    process.stdout.write(message);
  },
  stderr: (message) => {
    process.stderr.write(message);
  },
};

