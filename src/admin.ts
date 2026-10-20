
export const ADMIN_WALLET =
  "0xee697e2c141698e9D964A7CeC9524E5Aca96396a" as const;

export function isAdminWallet(
  address: string | undefined | null
): boolean {
  if (!address) return false;

  return address.toLowerCase() === ADMIN_WALLET.toLowerCase();
}
