interface SendReceipt {
  success?: boolean
  code?: number
  data?: {
    comment?: string
    common_response?: { common_result?: number }
  }
}

/** Confirmed against a live Qianfan send and the receiving viewer on 2026-09-08. */
export function isConfirmedSendReceipt(body: unknown, message: string): boolean {
  const receipt = body as SendReceipt | null | undefined
  return (
    receipt?.success === true &&
    receipt.code === 0 &&
    receipt.data?.comment === message &&
    receipt.data.common_response?.common_result === 1
  )
}
