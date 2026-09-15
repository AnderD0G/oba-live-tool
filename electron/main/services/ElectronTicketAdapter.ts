import { BrowserWindow } from 'electron'
import type { PrintTicket } from '../../../shared/capturePrinting'
import { type Paper, type PrintAdapter, ticketHtml } from './TicketPrinter'
export class ElectronTicketAdapter implements PrintAdapter {
  private async window(tickets: PrintTicket[], paper: Paper, show: boolean) {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 900,
      title: '扣号单打印预览',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: false,
      },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', e => e.preventDefault())
    try {
      await win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(ticketHtml(tickets, paper))}`,
      )
      if (show) win.show()
      return win
    } catch (e) {
      win.destroy()
      throw e
    }
  }
  async preview(tickets: PrintTicket[], paper: Paper) {
    await this.window(tickets, paper, true)
  }
  async print(ticket: PrintTicket, printer: string, paper: Paper) {
    const win = await this.window([ticket], paper, false)
    try {
      const printers = await win.webContents.getPrintersAsync()
      if (!printers.some(p => p.name === printer)) throw new Error('指定打印机不可用，请重新选择')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('打印提交超时，出纸状态未知，请核对后处理')),
          60000,
        )
        win.webContents.print(
          {
            silent: true,
            deviceName: printer,
            printBackground: true,
            copies: 1,
            margins:
              paper === '40x30'
                ? { marginType: 'none' }
                : { marginType: 'custom', top: 5, bottom: 5, left: 5, right: 5 },
            pageSize:
              paper === 'A4'
                ? 'A4'
                : paper === '40x30'
                  ? { width: 40000, height: 30000 }
                  : { width: paper === '80mm' ? 80000 : 58000, height: 200000 },
          },
          (success, reason) => {
            clearTimeout(timer)
            success ? resolve() : reject(new Error(reason || '打印机未接受任务'))
          },
        )
      })
    } finally {
      win.destroy()
    }
  }
}
