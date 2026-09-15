import { createHashRouter } from 'react-router'
import AIChat from '@/pages/AIChat'
import AutoMessage from '@/pages/AutoMessage'
import AutoPopUp from '@/pages/AutoPopUp'
import AutoReply from '@/pages/AutoReply'
import AutoReplySettings from '@/pages/AutoReply/AutoReplySettings'
import CapturePrinting from '@/pages/CapturePrinting'
import CommentCatcher from '@/pages/CommentCatcher'
import LiveControl from '@/pages/LiveControl'
import RedPacket from '@/pages/RedPacket'
import Settings from '@/pages/SettingsPage'
import Setup from '@/pages/Setup'
import App from '../App'

export const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { path: '/setup', element: <Setup /> },
      { path: '/comment-catcher', element: <CommentCatcher /> },
      { path: '/capture-printing', element: <CapturePrinting /> },
      {
        path: '/',
        element: <LiveControl />,
      },
      {
        path: '/auto-message',
        element: <AutoMessage />,
      },
      {
        path: '/auto-popup',
        element: <AutoPopUp />,
      },
      {
        path: '/settings',
        element: <Settings />,
      },
      {
        path: '/ai-chat',
        element: <AIChat />,
      },
      {
        path: 'auto-reply',
        element: <AutoReply />,
      },
      {
        path: '/auto-reply/settings',
        element: <AutoReplySettings />,
      },
      {
        path: '/red-packet',
        element: <RedPacket />,
      },
    ],
  },
])
