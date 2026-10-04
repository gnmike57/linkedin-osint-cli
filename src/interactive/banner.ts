/* ASCII banner for the interactive launcher. Pure — easy to unit test. */

export function bannerLines(version: string): string[] {
  return [
    '',
    '  ██╗     ██╗███╗   ██╗██╗  ██╗███████╗██████╗ ██╗███╗   ██╗',
    '  ██║     ██║████╗  ██║██║ ██╔╝██╔════╝██╔══██╗██║████╗  ██║',
    '  ██║     ██║██╔██╗ ██║█████╔╝ █████╗  ██║  ██║██║██╔██╗ ██║',
    '  ██║     ██║██║╚██╗██║██╔═██╗ ██╔══╝  ██║  ██║██║██║╚██╗██║',
    '  ███████╗██║██║ ╚████║██║  ██╗███████╗██████╔╝██║██║ ╚████║',
    '  ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝╚═╝  ╚═══╝',
    '',
    `         linkedin-cli  ·  v${version}  ·  interactive console`,
    '',
  ];
}

export function renderBanner(version: string): string {
  return bannerLines(version).join('\n');
}
