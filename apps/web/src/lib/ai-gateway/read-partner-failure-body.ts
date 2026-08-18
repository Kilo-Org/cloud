export function readPartnerFailureBody(response: Response): Promise<string> {
  return response.text();
}
