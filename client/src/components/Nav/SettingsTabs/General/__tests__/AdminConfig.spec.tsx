import userEvent from '@testing-library/user-event';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { TAdminConfig } from 'librechat-data-provider';
import { render, screen } from 'test/layout-test-utils';
import AdminConfig from '../AdminConfig';

const mockUseAdminConfigsQuery = jest.fn();
const mockUseAdminConfigQuery = jest.fn();
const mockUseToggleAdminConfigMutation = jest.fn();
const mockIdleMutation = () => ({ isLoading: false, mutate: jest.fn() });

/**
 * The components read these through the `~/data-provider` barrel, so every hook the
 * rendered tree imports has to be present here — a name left out arrives as
 * `undefined` and the render throws rather than failing an assertion.
 */
jest.mock('~/data-provider/AdminConfig/queries', () => ({
  useAdminConfigsQuery: () => mockUseAdminConfigsQuery(),
  useAdminConfigQuery: (principalType: string, principalId: string) =>
    mockUseAdminConfigQuery(principalType, principalId),
  useToggleAdminConfigMutation: () => mockUseToggleAdminConfigMutation(),
  useUpsertAdminConfigMutation: () => mockIdleMutation(),
  usePatchAdminConfigFieldsMutation: () => mockIdleMutation(),
  useTombstoneAdminConfigFieldMutation: () => mockIdleMutation(),
  useDeleteAdminConfigFieldMutation: () => mockIdleMutation(),
  useDeleteAdminConfigMutation: () => mockIdleMutation(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useMediaQuery: () => false,
}));

const storedConfig: TAdminConfig = {
  _id: 'config-1',
  principalType: PrincipalType.USER,
  principalModel: PrincipalModel.USER,
  principalId: 'user-1',
  priority: 5,
  overrides: {},
  tombstones: [],
  isActive: true,
  configVersion: 3,
};

const loadingList = { data: undefined, isLoading: true, isError: false };
const emptyList = { data: { configs: [] }, isLoading: false, isError: false };
const failedList = { data: undefined, isLoading: false, isError: true };
const storedList = { data: { configs: [storedConfig] }, isLoading: false, isError: false };
const storedDetail = { data: { config: storedConfig }, isLoading: false, isError: false };

beforeEach(() => {
  mockUseAdminConfigQuery.mockReturnValue(storedDetail);
  mockUseToggleAdminConfigMutation.mockReturnValue({ isLoading: false, mutate: jest.fn() });
});

describe('AdminConfig', () => {
  it('shows that the set list is still loading', () => {
    mockUseAdminConfigsQuery.mockReturnValue(loadingList);

    render(<AdminConfig />);

    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_admin_config_empty')).not.toBeInTheDocument();
  });

  it('invites the admin to create the first set when none is stored', () => {
    mockUseAdminConfigsQuery.mockReturnValue(emptyList);

    render(<AdminConfig />);

    expect(screen.getByText('com_ui_admin_config_empty')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_admin_config_select')).not.toBeInTheDocument();
  });

  it('reports a set list that failed to load', () => {
    mockUseAdminConfigsQuery.mockReturnValue(failedList);

    render(<AdminConfig />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_admin_config_load_error');
    expect(screen.queryByText('com_ui_admin_config_select')).not.toBeInTheDocument();
  });

  it('asks for a selection instead of showing detail for no set', () => {
    mockUseAdminConfigsQuery.mockReturnValue(storedList);

    render(<AdminConfig />);

    expect(screen.getByText('user-1')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_config_select')).toBeInTheDocument();
  });

  it('opens the detail of the set the admin selects', async () => {
    const user = userEvent.setup();
    mockUseAdminConfigsQuery.mockReturnValue(storedList);

    render(<AdminConfig />);
    await user.click(screen.getByRole('button', { name: 'com_ui_edit' }));

    expect(mockUseAdminConfigQuery).toHaveBeenCalledWith(PrincipalType.USER, 'user-1');
    expect(screen.getByText('com_ui_admin_config_overrides')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_config_tombstones_none')).toBeInTheDocument();
  });

  it('collects a principal and its overrides when creating a set', async () => {
    const user = userEvent.setup();
    mockUseAdminConfigsQuery.mockReturnValue(emptyList);

    render(<AdminConfig />);
    await user.click(screen.getByRole('button', { name: 'com_ui_admin_config_new' }));

    expect(screen.getByText('com_ui_admin_config_new_title')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_config_principal_type')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('com_ui_admin_config_principal_id_placeholder'),
    ).toBeInTheDocument();
  });
});
