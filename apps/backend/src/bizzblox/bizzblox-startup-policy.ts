export function shouldStartMcp(serviceMode: string | undefined): boolean {
  return serviceMode !== '1';
}
