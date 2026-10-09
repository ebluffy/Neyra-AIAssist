import { Command, Moon, Sun } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Theme } from '@/lib/theme'

type Props = {
  crumbs: string[]
  theme: Theme
  onThemeToggle: () => void
  onOpenCommand: () => void
}

export function Topbar({ crumbs, theme, onThemeToggle, onOpenCommand }: Props) {
  return (
    <header className="topbar">
      <nav aria-label="Хлебные крошки" className="topbar-crumbs">
        {crumbs.map((c, i) => (
          <span className="topbar-crumb" key={`${c}-${i}`}>
            {i > 0 ? <span className="topbar-crumb-sep" aria-hidden>/</span> : null}
            {i === crumbs.length - 1 ? (
              <span aria-current="page">{c}</span>
            ) : (
              <Link className="topbar-crumb-link" to={i === 0 && c === 'Статус' ? '/status' : '#'}>
                {c}
              </Link>
            )}
          </span>
        ))}
      </nav>
      <div className="topbar-actions">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label="Командная палитра" onClick={onOpenCommand} size="icon" type="button" variant="ghost">
              <Command aria-hidden size={16} strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>⌘K</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'}
              onClick={onThemeToggle}
              size="icon"
              type="button"
              variant="ghost"
            >
              {theme === 'light' ? (
                <Moon aria-hidden size={16} strokeWidth={1.75} />
              ) : (
                <Sun aria-hidden size={16} strokeWidth={1.75} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Тема</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
