declare module '@inquirer/prompts' {
  export function input(options: { message: string }): Promise<string>;
  export function confirm(options: { message: string; default?: boolean }): Promise<boolean>;
  export function password(options: { message: string }): Promise<string>;
}
