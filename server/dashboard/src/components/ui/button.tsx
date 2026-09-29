import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      secondary: 'btn-secondary',
      ghost: 'btn-secondary',
      danger: 'btn-danger',
      warn: 'btn-warn',
      cyan: 'btn-cyan',
    },
    size: {
      default: '',
      sm: 'btn-sm',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
})

type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, ...props }: Props) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
