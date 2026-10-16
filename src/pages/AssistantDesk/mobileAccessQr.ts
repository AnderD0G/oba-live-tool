import { qrcodegen } from '../../vendor/qrcodegen'

/** Local-only QR generation: the phone access address never leaves this computer. */
export function mobileAccessQr(url: string): string {
  const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM)
  const quietZone = 4
  const size = qr.size + quietZone * 2
  const cells: string[] = []
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.getModule(x, y))
        cells.push('M' + (x + quietZone) + ',' + (y + quietZone) + 'h1v1h-1z')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
    '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path fill="black" d="' +
    cells.join('') + '"/></svg>'
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

