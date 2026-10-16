import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type FollowScrollSpeed = 'slow' | 'medium' | 'fast'
const pixelsPerSecond = { slow: 90, medium: 240, fast: 600 }

export function useScrollFollow(content: unknown, {
  enabled = true,
  preserveAnchor = false,
  resetKey,
}: { enabled?: boolean; preserveAnchor?: boolean; resetKey?: string } = {}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const followingIntent = useRef(true)
  const followingRef = useRef(true)
  const [hovered, setHovered] = useState(false)
  const hoveredRef = useRef(false)
  const [speed, setSpeed] = useState<FollowScrollSpeed>('slow')
  const activeFollowing = enabled && following && !hovered
  const programmaticTop = useRef(0)
  const readingAnchor = useRef<{ id: string; top: number }[]>([])
  const lastResetKey = useRef(resetKey)

  const captureAnchor = () => {
    const element = viewport.current
    if (!preserveAnchor || !element) return
    const bounds = element.getBoundingClientRect()
    const visible: { id: string; top: number }[] = []
    for (const card of element.querySelectorAll<HTMLElement>('[data-row-id]')) {
      const rect = card.getBoundingClientRect()
      if (rect.bottom <= bounds.top) continue
      visible.push({ id: card.dataset.rowId!, top: rect.top - bounds.top })
      if (visible.length === 3) break
    }
    readingAnchor.current = visible
  }
  const setTop = (value: number) => {
    const element = viewport.current
    if (!element) return
    element.scrollTop = value
    programmaticTop.current = element.scrollTop
  }
  const pause = () => {
    captureAnchor()
    followingIntent.current = false
    followingRef.current = false
    setFollowing(false)
  }
  const resume = () => {
    followingIntent.current = true
    followingRef.current = enabled && !hoveredRef.current
    setFollowing(true)
  }
  const enter = () => {
    captureAnchor()
    hoveredRef.current = true
    followingRef.current = false
    setHovered(true)
  }
  const leave = () => {
    captureAnchor()
    hoveredRef.current = false
    followingRef.current = enabled && followingIntent.current
    setHovered(false)
  }
  const onScroll = () => {
    const element = viewport.current
    if (!element) return
    if (Math.abs(element.scrollTop - programmaticTop.current) > 1) pause()
    captureAnchor()
  }
  const returnStart = () => {
    readingAnchor.current = []
    setTop(0)
    captureAnchor()
    resume()
  }

  useLayoutEffect(() => {
    followingRef.current = enabled && followingIntent.current && !hoveredRef.current
  }, [enabled])
  useLayoutEffect(() => {
    if (!preserveAnchor || !viewport.current) return
    if (lastResetKey.current !== resetKey) {
      lastResetKey.current = resetKey
      readingAnchor.current = []
      setTop(0)
    } else {
      const element = viewport.current
      const bounds = element.getBoundingClientRect()
      const cards = new Map([...element.querySelectorAll<HTMLElement>('[data-row-id]')]
        .map(card => [card.dataset.rowId!, card]))
      for (const anchor of readingAnchor.current) {
        const card = cards.get(anchor.id)
        if (!card) continue
        const shift = card.getBoundingClientRect().top - bounds.top - anchor.top
        if (Math.abs(shift) > 0.5) setTop(element.scrollTop + shift)
        break
      }
    }
    // Removing all visible cards can make the browser clamp its own scroll position.
    programmaticTop.current = viewport.current.scrollTop
    captureAnchor()
  }, [content, preserveAnchor, resetKey])
  useEffect(() => {
    if (!activeFollowing || !viewport.current) return
    const element = viewport.current
    let frame = 0
    let last = performance.now()
    const move = (now: number) => {
      if (!followingRef.current) return
      const target = Math.max(0, element.scrollHeight - element.clientHeight)
      const remaining = target - element.scrollTop
      if (remaining <= 1) return
      const step = (pixelsPerSecond[speed] * Math.min(100, now - last)) / 1000
      setTop(element.scrollTop + Math.min(remaining, Math.max(1, step)))
      captureAnchor()
      last = now
      frame = requestAnimationFrame(move)
    }
    frame = requestAnimationFrame(move)
    return () => cancelAnimationFrame(frame)
  }, [activeFollowing, speed, content])

  return { viewport, following, followingRef, hovered, hoveredRef, activeFollowing,
    speed, setSpeed, pause, resume, enter, leave, onScroll, returnStart }
}
