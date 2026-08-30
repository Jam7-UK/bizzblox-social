export function shouldStartMcp(serviceMode: string | undefined): boolean {
  return serviceMode !== '1';
}

export function shouldRegisterPostizStartupHooks(
  serviceMode: string | undefined
): boolean {
  return serviceMode !== '1';
}
