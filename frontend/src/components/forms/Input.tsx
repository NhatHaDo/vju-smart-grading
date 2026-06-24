import { InputHTMLAttributes, forwardRef, ReactNode, useState } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  leftIcon?: ReactNode;
  rightElement?: ReactNode;
  wrapperStyle?: React.CSSProperties;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, leftIcon, rightElement, wrapperStyle, style, ...rest }, ref) => {
    const [focused, setFocused] = useState(false);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, ...wrapperStyle }}>
        {label && (
          <label
            style={{ fontSize: 12, fontWeight: 700, color: '#555', userSelect: 'none' }}
          >
            {label}
          </label>
        )}

        <div style={{ position: 'relative' }}>
          {leftIcon && (
            <span
              style={{
                position: 'absolute',
                left: 13,
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                color: focused ? '#C8102E' : '#9CA3AF',
                display: 'flex',
                transition: 'color 160ms',
              }}
            >
              {leftIcon}
            </span>
          )}

          <input
            ref={ref}
            onFocus={e => { setFocused(true); rest.onFocus?.(e); }}
            onBlur={e => { setFocused(false); rest.onBlur?.(e); }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              borderRadius: 10,
              border: `1.5px solid ${error ? '#FECACA' : focused ? '#C8102E' : '#EBEBEB'}`,
              boxShadow: error
                ? '0 0 0 3px rgba(200,16,46,0.08)'
                : focused
                ? '0 0 0 3px rgba(200,16,46,0.08)'
                : 'none',
              padding: `11px ${rightElement ? '44px' : '14px'} 11px ${leftIcon ? '42px' : '14px'}`,
              fontSize: 14,
              background: '#fafafa',
              color: '#1E1E1E',
              fontFamily: 'inherit',
              outline: 'none',
              transition: 'border-color 160ms, box-shadow 160ms',
              ...style,
            }}
            {...rest}
          />

          {rightElement && (
            <span
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'flex',
              }}
            >
              {rightElement}
            </span>
          )}
        </div>

        {error && (
          <span style={{ fontSize: 12, color: '#991B1B', fontWeight: 600 }}>{error}</span>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
export default Input;
