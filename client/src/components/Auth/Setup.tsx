import React, { useContext, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Turnstile } from '@marsidev/react-turnstile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { ThemeContext, SecretInput, Spinner, Button, Input, isDark } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import type { TurnstileInstance } from '@marsidev/react-turnstile';
import type { TLoginLayoutContext } from '~/common';
import { validateEmail } from '~/utils';
import { useLocalize } from '~/hooks';
import { ErrorMessage } from './ErrorMessage';

/** The deployment's initialization state, as reported by `GET /api/setup/status`. */
export type TSetupStatus = {
  required: boolean;
};

type TSetupForm = {
  name: string;
  email: string;
  username: string;
  password: string;
  confirm_password: string;
};

export const setupStatusKey = ['setupStatus'] as const;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function useSetupStatus() {
  return useQuery<TSetupStatus>({
    queryKey: setupStatusKey,
    queryFn: async () => {
      const response = await fetch(`${apiBaseUrl()}/api/setup/status`);
      if (!response.ok) {
        throw new Error('Unable to read the initialization state');
      }
      return (await response.json()) as TSetupStatus;
    },
    retry: false,
    staleTime: 0,
  });
}

const Setup: React.FC = () => {
  const navigate = useNavigate();
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { theme } = useContext(ThemeContext);
  const { startupConfig } = useOutletContext<TLoginLayoutContext>();
  const status = useSetupStatus();

  const {
    watch,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<TSetupForm>({ mode: 'onChange' });
  const password = watch('password');

  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isCreated, setIsCreated] = useState(false);
  const [countdown, setCountdown] = useState<number>(3);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>();

  const requireCaptcha = Boolean(startupConfig?.turnstile?.siteKey);
  const turnstile = startupConfig?.turnstile;
  const validTheme = isDark(theme) ? 'dark' : 'light';

  const authInputClassName =
    'webkit-dark-styles transition-color peer h-auto w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pt-3 text-text-primary duration-200 hover:border-border-light focus:border-accent-primary focus:outline-none focus-visible:border-accent-primary';
  const authSecretInputClassName = `${authInputClassName} pr-12`;
  const authLabelClassName =
    'absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-accent-primary rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4';
  const authSecretButtonClassName =
    'size-9 rounded-xl text-text-secondary-alt hover:bg-transparent hover:text-text-primary';

  const resetTurnstile = () => {
    setTurnstileToken(null);
    turnstileRef.current?.reset();
  };

  const initialize = useMutation({
    mutationFn: async (payload: TSetupForm & { turnstileToken?: string }) => {
      const response = await fetch(`${apiBaseUrl()}/api/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          typeof body.message === 'string' ? body.message : 'Unable to initialize this deployment',
        );
      }
      return body;
    },
    onSuccess: () => setIsCreated(true),
    onError: (error: unknown) => {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to initialize this deployment',
      );
      resetTurnstile();
    },
  });

  useEffect(() => {
    if (!isCreated) {
      return;
    }
    const timer = setInterval(() => {
      setCountdown((remaining) => (remaining <= 1 ? 0 : remaining - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [isCreated]);

  /** Recording the answer before navigating is what keeps the login page from rendering the
   *  setup form again from the cached `required: true` while its refetch is in flight. */
  useEffect(() => {
    if (!isCreated || countdown > 0) {
      return;
    }
    queryClient.setQueryData(setupStatusKey, { required: false });
    navigate('/login', { replace: true });
  }, [isCreated, countdown, navigate, queryClient]);

  /** Reached by URL, the page has to send an already-initialized deployment back to sign in
   *  instead of offering a second administrator form. */
  useEffect(() => {
    if (isCreated) {
      return;
    }
    if (status.data?.required === false || status.isError) {
      navigate('/login', { replace: true });
    }
  }, [isCreated, status.data, status.isError, navigate]);

  if (isCreated) {
    return (
      <div className="mt-6 flex flex-col items-center gap-2" role="status">
        <p className="text-lg font-semibold text-text-primary">
          {localize('com_auth_setup_complete')}
        </p>
        <p className="text-sm font-light text-text-secondary">
          {localize('com_auth_email_verification_redirecting', { 0: countdown.toString() })}
        </p>
      </div>
    );
  }

  if (status.data?.required !== true) {
    return null;
  }

  const renderError = (fieldName: keyof TSetupForm) => {
    const fieldError = errors[fieldName]?.message;
    return fieldError ? (
      <span role="alert" className="mt-1 text-sm text-text-destructive">
        {String(fieldError)}
      </span>
    ) : null;
  };

  return (
    <>
      <p className="mt-4 text-center text-sm font-light text-text-secondary">
        {localize('com_auth_setup_description')}
      </p>
      {errorMessage !== '' && <ErrorMessage>{errorMessage}</ErrorMessage>}
      <form
        className="mt-6"
        aria-label={localize('com_auth_setup_title')}
        method="POST"
        onSubmit={handleSubmit((data) => {
          if (requireCaptcha && !turnstileToken) {
            return;
          }
          setErrorMessage('');
          initialize.mutate({
            ...data,
            ...(requireCaptcha && turnstileToken ? { turnstileToken } : {}),
          });
        })}
      >
        <div className="mb-4">
          <div className="relative">
            <Input
              id="name"
              type="text"
              autoComplete="name"
              aria-label={localize('com_auth_full_name')}
              {...register('name', {
                required: localize('com_auth_name_required'),
                minLength: { value: 3, message: localize('com_auth_name_min_length') },
                maxLength: { value: 80, message: localize('com_auth_name_max_length') },
              })}
              aria-invalid={!!errors.name}
              className={authInputClassName}
              placeholder=" "
            />
            <label htmlFor="name" className={authLabelClassName}>
              {localize('com_auth_full_name')}
            </label>
          </div>
          {renderError('name')}
        </div>
        <div className="mb-4">
          <div className="relative">
            <Input
              id="email"
              type="text"
              autoComplete="email"
              aria-label={localize('com_auth_email')}
              {...register('email', {
                required: localize('com_auth_email_required'),
                maxLength: { value: 120, message: localize('com_auth_email_max_length') },
                validate: (value) => validateEmail(value, localize('com_auth_email_pattern')),
              })}
              aria-invalid={!!errors.email}
              className={authInputClassName}
              placeholder=" "
            />
            <label htmlFor="email" className={authLabelClassName}>
              {localize('com_auth_email_address')}
            </label>
          </div>
          {renderError('email')}
        </div>
        <div className="mb-4">
          <div className="relative">
            <Input
              id="username"
              type="text"
              autoComplete="username"
              aria-label={localize('com_auth_username')}
              {...register('username', {
                minLength: { value: 2, message: localize('com_auth_username_min_length') },
                maxLength: { value: 80, message: localize('com_auth_username_max_length') },
              })}
              aria-invalid={!!errors.username}
              className={authInputClassName}
              placeholder=" "
            />
            <label htmlFor="username" className={authLabelClassName}>
              {localize('com_auth_username')}
            </label>
          </div>
          {renderError('username')}
        </div>
        <div className="mb-4">
          <div className="relative">
            <SecretInput
              id="password"
              autoComplete="new-password"
              aria-label={localize('com_auth_password')}
              {...register('password', {
                required: localize('com_auth_password_required'),
                minLength: {
                  value: startupConfig?.minPasswordLength || 8,
                  message: localize('com_auth_password_min_length'),
                },
                maxLength: { value: 128, message: localize('com_auth_password_max_length') },
              })}
              aria-invalid={!!errors.password}
              className={authSecretInputClassName}
              placeholder=" "
              label={localize('com_auth_password')}
              labelClassName={authLabelClassName}
              controlsClassName="right-2"
              buttonClassName={authSecretButtonClassName}
            />
          </div>
          {renderError('password')}
        </div>
        <div className="mb-4">
          <div className="relative">
            <SecretInput
              id="confirm_password"
              autoComplete="new-password"
              aria-label={localize('com_auth_password_confirm')}
              {...register('confirm_password', {
                validate: (value) => value === password || localize('com_auth_password_not_match'),
              })}
              aria-invalid={!!errors.confirm_password}
              className={authSecretInputClassName}
              placeholder=" "
              label={localize('com_auth_password_confirm')}
              labelClassName={authLabelClassName}
              controlsClassName="right-2"
              buttonClassName={authSecretButtonClassName}
            />
          </div>
          {renderError('confirm_password')}
        </div>

        {turnstile?.siteKey != null && (
          <div className="my-4 flex justify-center">
            <Turnstile
              ref={turnstileRef}
              siteKey={turnstile.siteKey}
              options={{
                ...turnstile.options,
                theme: validTheme,
              }}
              onSuccess={setTurnstileToken}
              onError={resetTurnstile}
              onExpire={resetTurnstile}
              onTimeout={resetTurnstile}
            />
          </div>
        )}

        <div className="mt-6">
          <Button
            aria-label={localize('com_auth_setup_submit')}
            data-testid="setup-button"
            type="submit"
            disabled={(requireCaptcha && !turnstileToken) || initialize.isLoading}
            variant="submit"
            className="h-12 w-full rounded-2xl"
          >
            {initialize.isLoading ? <Spinner /> : localize('com_auth_setup_submit')}
          </Button>
        </div>
      </form>
    </>
  );
};

export default Setup;
