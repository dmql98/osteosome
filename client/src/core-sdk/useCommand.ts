export function useCommand() {
  async function send(topic: string, payload?: Record<string, unknown>): Promise<boolean> {
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, ...(payload ? { payload } : {}) }),
      })
      if (!response.ok) console.error(`[command] ${topic} failed: ${response.status}`)
      return response.ok
    } catch (error) {
      console.error(`[command] ${topic} failed`, error)
      return false
    }
  }
  return { send }
}
