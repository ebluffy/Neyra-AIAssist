import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      primary: 'btn-primary',
      secondary: 'btn-secondary',
      outline: 'btn-secondary',
      ghost: 'btn-secondary',
      danger: 'btn-danger',
      destructive: 'btn-danger',
      warn: 'btn-warn',
      cyan: 'btn-cyan',
    },
    size: {
      default: '',
      sm: 'btn-sm',
      md: '',
      icon: 'btn-sm',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
})

type Props = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }

function Button({ className, variant, size, asChild = false, loading, disabled, children, ...props }: Props) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {children}
    </Comp>
  )
}

export { Button, buttonVariants }
