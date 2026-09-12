import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import Registration from '../Registration';
import { useRegisterUserMutation } from 'librechat-data-provider/react-query';

const mockNavigate = jest.fn();
const mockUseOutletContext = jest.fn();
const mockTurnstileReset = jest.fn();

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ search: '' }),
    useOutletContext: () => mockUseOutletContext(),
  };
});

jest.mock('librechat-data-provider', () => ({
  loginPage: () => '/login',
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useRegisterUserMutation: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

jest.mock('@librechat/client', () => {
  const React = require('react');

  return {
    ThemeContext: React.createContext({ theme: 'light' }),
    SecretInput: React.forwardRef(({ label: _label, ...props }, ref) =>
      React.createElement('input', { ...props, ref, type: 'password' }),
    ),
    Input: React.forwardRef((props, ref) => React.createElement('input', { ...props, ref })),
    Spinner: () => React.createElement('div', { 'data-testid': 'spinner' }, 'Loading...'),
    Button: ({ children, ...props }) => React.createElement('button', props, children),
    isDark: (theme: string) => theme === 'dark',
  };
});

jest.mock('@marsidev/react-turnstile', () => {
  const React = require('react');

  return {
    Turnstile: React.forwardRef(
      ({ onSuccess, onError, onExpire, onTimeout, siteKey, options }, ref) => {
        React.useImperativeHandle(ref, () => ({
          reset: mockTurnstileReset,
          remove: jest.fn(),
          render: jest.fn(),
          execute: jest.fn(),
          getResponse: jest.fn(),
          getResponsePromise: jest.fn(),
          isExpired: jest.fn(),
        }));

        return React.createElement(
          'div',
          { 'data-testid': 'turnstile-widget' },
          React.createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'turnstile-success',
              onClick: () => onSuccess('mock-turnstile-token'),
            },
            'Complete Captcha',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'turnstile-error',
              onClick: () => onError('test-error'),
            },
            'Trigger Error',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'turnstile-expire',
              onClick: () => onExpire('mock-turnstile-token'),
            },
            'Expire Token',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'turnstile-timeout',
              onClick: () => onTimeout(),
            },
            'Timeout Token',
          ),
          React.createElement('div', { 'data-testid': 'turnstile-sitekey' }, siteKey),
          React.createElement(
            'div',
            { 'data-testid': 'turnstile-options' },
            JSON.stringify(options),
          ),
        );
      },
    ),
  };
});

const mockStartupConfig = {
  emailEnabled: true,
  registrationEnabled: true,
  minPasswordLength: 8,
};

const mockStartupConfigWithTurnstile = {
  ...mockStartupConfig,
  turnstile: {
    siteKey: 'test-site-key',
    options: {
      language: 'en',
      size: 'normal',
      theme: 'auto',
    },
  },
};

let registerOptions: { onError?: (error: unknown) => void } = {};
let mutate: jest.Mock;

const renderRegistration = (startupConfig = mockStartupConfig) => {
  mockUseOutletContext.mockReturnValue({
    startupConfig,
    startupConfigError: null,
    isFetching: false,
  });

  return render(
    <BrowserRouter>
      <Registration />
    </BrowserRouter>,
  );
};

const fillRegistrationForm = async () => {
  const user = userEvent.setup();

  await user.type(screen.getByTestId('name'), 'Test User');
  await user.type(screen.getByTestId('username'), 'testuser');
  await user.type(screen.getByTestId('email'), 'test@example.com');
  await user.type(screen.getByTestId('password'), 'password123');
  await user.type(screen.getByTestId('confirm_password'), 'password123');

  return user;
};

beforeEach(() => {
  jest.clearAllMocks();
  registerOptions = {};
  mutate = jest.fn();

  (useRegisterUserMutation as jest.Mock).mockImplementation((options) => {
    registerOptions = options;
    return {
      mutate,
      isSuccess: false,
    };
  });
});

describe('Registration Turnstile integration', () => {
  it('submits without a turnstile token when Turnstile is disabled', async () => {
    renderRegistration();
    const user = await fillRegistrationForm();

    await user.click(screen.getByRole('button', { name: /Submit registration/i }));

    expect(screen.queryByTestId('turnstile-widget')).not.toBeInTheDocument();
    expect(mutate).toHaveBeenCalledWith({
      name: 'Test User',
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
      confirm_password: 'password123',
      token: undefined,
    });
  });

  it('requires a completed turnstile challenge before submitting', async () => {
    renderRegistration(mockStartupConfigWithTurnstile);
    const user = await fillRegistrationForm();

    const submitButton = screen.getByRole('button', { name: /Submit registration/i });
    expect(submitButton).toBeDisabled();

    await user.click(screen.getByTestId('turnstile-success'));
    expect(submitButton).not.toBeDisabled();

    await user.click(submitButton);

    expect(mutate).toHaveBeenCalledWith({
      name: 'Test User',
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
      confirm_password: 'password123',
      token: undefined,
      turnstileToken: 'mock-turnstile-token',
    });
  });

  it('resets turnstile state after widget errors and expiry', async () => {
    renderRegistration(mockStartupConfigWithTurnstile);
    const user = await fillRegistrationForm();

    const submitButton = screen.getByRole('button', { name: /Submit registration/i });
    await user.click(screen.getByTestId('turnstile-success'));
    expect(submitButton).not.toBeDisabled();

    await user.click(screen.getByTestId('turnstile-error'));
    expect(mockTurnstileReset).toHaveBeenCalledTimes(1);
    expect(submitButton).toBeDisabled();

    await user.click(screen.getByTestId('turnstile-success'));
    expect(submitButton).not.toBeDisabled();

    await user.click(screen.getByTestId('turnstile-expire'));
    expect(mockTurnstileReset).toHaveBeenCalledTimes(2);
    expect(submitButton).toBeDisabled();
  });

  it('resets turnstile state when registration fails', async () => {
    mutate.mockImplementation(() =>
      registerOptions.onError?.({
        response: {
          data: {
            message: 'Captcha verification failed. Please try again.',
          },
        },
      }),
    );

    renderRegistration(mockStartupConfigWithTurnstile);
    const user = await fillRegistrationForm();

    await user.click(screen.getByTestId('turnstile-success'));
    await user.click(screen.getByRole('button', { name: /Submit registration/i }));

    expect(mockTurnstileReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Captcha verification failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit registration/i })).toBeDisabled();
  });
});
