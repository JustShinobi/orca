// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BulkActionBar } from './bulk-action-bar'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

describe('BulkActionBar', () => {
  it('exposes the icon-only clear control to assistive tech by name', () => {
    const onClear = vi.fn()
    render(
      <BulkActionBar
        selectedCount={2}
        stageableCount={1}
        unstageableCount={1}
        onStage={vi.fn()}
        onUnstage={vi.fn()}
        onClear={onClear}
        isExecuting={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
