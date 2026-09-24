export interface Preferences {
  layout?: string
  [key: string]: unknown
}

export function usePreferences() {
  const get = async (): Promise<Preferences> => {
    const response = await fetch('/api/preferences')
    if (!response.ok) throw new Error(`preferences GET failed: ${response.status}`)
    return (await response.json()) as Preferences
  }
  const put = async (preferences: Preferences): Promise<void> => {
    const response = await fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preferences),
    })
    if (!response.ok) throw new Error(`preferences PUT failed: ${response.status}`)
  }
  return { get, put }
}
