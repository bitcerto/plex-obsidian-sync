export class App {}

export class TFile {}

export async function requestUrl(): Promise<{ status: number; text: string }> {
  throw new Error("requestUrl stub should not be called directly in tests");
}
