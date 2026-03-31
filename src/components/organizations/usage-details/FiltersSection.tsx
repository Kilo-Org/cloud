'use client';
import { useMemo, useState } from 'react';
import { FilterCard, type FilterCardItem } from './FilterCard';
import { FilterModal } from './FilterModal';

type OrganizationUsageMetric =
  | 'cost'
  | 'requests'
  | 'avg_cost_per_req'
  | 'tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'active_users';

type TimeseriesDataPoint = {
  datetime: string;
  name: string;
  email: string;
  model: string;
  provider: string;
  projectId: string | null;
  costMicrodollars: number;
  inputTokenCount: number;
  outputTokenCount: number;
  requestCount: number;
};

type ActiveFilter = {
  type: 'include' | 'exclude';
  subType: 'user' | 'project' | 'model';
  value: string;
};

export interface FiltersSectionProps {
  selectedMetric: OrganizationUsageMetric;
  timeseriesData: TimeseriesDataPoint[];
  filteredTimeseriesData: TimeseriesDataPoint[];
  activeFilters?: ActiveFilter[];
  onFilter?: (subType: 'user' | 'project' | 'model', value: string) => void;
  onExclude?: (subType: 'user' | 'project' | 'model', value: string) => void;
  className?: string;
}

export function FiltersSection({
  selectedMetric,
  timeseriesData,
  filteredTimeseriesData,
  activeFilters = [],
  onFilter,
  onExclude,
  className = '',
}: FiltersSectionProps) {
  // Modal state
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    title: string;
    items: FilterCardItem[];
    subType: 'user' | 'project' | 'model';
  }>({
    isOpen: false,
    title: '',
    items: [],
    subType: 'user',
  });

  // Helper function to get the metric value from a data point
  const getMetricValue = (point: TimeseriesDataPoint, metric: OrganizationUsageMetric): number => {
    switch (metric) {
      case 'cost':
        return point.costMicrodollars || 0;
      case 'requests':
        return point.requestCount || 0;
      case 'tokens':
        return (point.inputTokenCount || 0) + (point.outputTokenCount || 0);
      case 'input_tokens':
        return point.inputTokenCount || 0;
      case 'output_tokens':
        return point.outputTokenCount || 0;
      case 'avg_cost_per_req':
        return (point.requestCount || 0) > 0
          ? (point.costMicrodollars || 0) / (point.requestCount || 0)
          : 0;
      case 'active_users':
        return 1; // Each data point represents one active user
      default:
        return 0;
    }
  };

  // Calculate filter card data for users
  const usersData = useMemo((): FilterCardItem[] => {
    // Get all unique users from raw data and calculate their raw values for initial sorting
    const rawUserTotals = new Map<string, number>();

    if (selectedMetric === 'avg_cost_per_req') {
      const rawUserCosts = new Map<string, number>();
      const rawUserRequests = new Map<string, number>();

      timeseriesData.forEach(point => {
        const cost = point.costMicrodollars || 0;
        const requests = point.requestCount || 0;
        rawUserCosts.set(point.email, (rawUserCosts.get(point.email) || 0) + cost);
        rawUserRequests.set(point.email, (rawUserRequests.get(point.email) || 0) + requests);
      });

      rawUserCosts.forEach((cost, user) => {
        const requests = rawUserRequests.get(user) || 0;
        rawUserTotals.set(user, requests > 0 ? cost / requests : 0);
      });
    } else {
      timeseriesData.forEach(point => {
        const value = getMetricValue(point, selectedMetric);
        rawUserTotals.set(point.email, (rawUserTotals.get(point.email) || 0) + value);
      });
    }

    // Sort by raw values to establish initial order
    const sortedUsers = Array.from(rawUserTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([user]) => user);

    // Now calculate filtered values for these users
    if (selectedMetric === 'avg_cost_per_req') {
      const userCosts = new Map<string, number>();
      const userRequests = new Map<string, number>();

      filteredTimeseriesData.forEach(point => {
        if (sortedUsers.includes(point.email)) {
          const cost = point.costMicrodollars || 0;
          const requests = point.requestCount || 0;
          userCosts.set(point.email, (userCosts.get(point.email) || 0) + cost);
          userRequests.set(point.email, (userRequests.get(point.email) || 0) + requests);
        }
      });

      const userValues = sortedUsers.map(user => {
        const cost = userCosts.get(user) || 0;
        const requests = userRequests.get(user) || 0;
        const rawValue = rawUserTotals.get(user) || 0;
        return {
          user,
          value: requests > 0 ? cost / requests : 0,
          rawValue,
        };
      });

      // Separate active and ghost items
      const activeItems = userValues.filter(item => item.value > 0);
      const ghostItems = userValues.filter(item => item.value === 0);

      // Sort active items by filtered value, ghost items maintain raw order
      activeItems.sort((a, b) => b.value - a.value);

      const sortedValues = [...activeItems, ...ghostItems];
      const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

      return sortedValues.map(({ user, value }) => ({
        label: user,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    // For other metrics
    const userTotals = new Map<string, number>();

    filteredTimeseriesData.forEach(point => {
      if (sortedUsers.includes(point.email)) {
        const value = getMetricValue(point, selectedMetric);
        userTotals.set(point.email, (userTotals.get(point.email) || 0) + value);
      }
    });

    const userValues = sortedUsers.map(user => ({
      user,
      value: userTotals.get(user) || 0,
      rawValue: rawUserTotals.get(user) || 0,
    }));

    // Separate active and ghost items
    const activeItems = userValues.filter(item => item.value > 0);
    const ghostItems = userValues.filter(item => item.value === 0);

    // Sort active items by filtered value, ghost items maintain raw order
    activeItems.sort((a, b) => b.value - a.value);

    const sortedValues = [...activeItems, ...ghostItems];
    const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

    return sortedValues.map(({ user, value }) => ({
      label: user,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }));
  }, [timeseriesData, filteredTimeseriesData, selectedMetric]);

  // Calculate filter card data for projects
  const projectsData = useMemo((): FilterCardItem[] => {
    // Calculate raw values for initial sorting
    const rawProjectTotals = new Map<string, number>();

    if (selectedMetric === 'active_users') {
      const rawProjectUsers = new Map<string, Set<string>>();
      timeseriesData.forEach(point => {
        const projectKey = point.projectId ?? 'No Project';
        if (point.requestCount > 0) {
          if (!rawProjectUsers.has(projectKey)) {
            rawProjectUsers.set(projectKey, new Set());
          }
          rawProjectUsers.get(projectKey)?.add(point.email);
        }
      });
      rawProjectUsers.forEach((users, project) => {
        rawProjectTotals.set(project, users.size);
      });
    } else if (selectedMetric === 'avg_cost_per_req') {
      const rawProjectCosts = new Map<string, number>();
      const rawProjectRequests = new Map<string, number>();
      timeseriesData.forEach(point => {
        const cost = point.costMicrodollars || 0;
        const requests = point.requestCount || 0;
        const projectKey = point.projectId ?? 'No Project';
        rawProjectCosts.set(projectKey, (rawProjectCosts.get(projectKey) || 0) + cost);
        rawProjectRequests.set(projectKey, (rawProjectRequests.get(projectKey) || 0) + requests);
      });
      rawProjectCosts.forEach((cost, project) => {
        const requests = rawProjectRequests.get(project) || 0;
        rawProjectTotals.set(project, requests > 0 ? cost / requests : 0);
      });
    } else {
      timeseriesData.forEach(point => {
        const value = getMetricValue(point, selectedMetric);
        const projectKey = point.projectId ?? 'No Project';
        rawProjectTotals.set(projectKey, (rawProjectTotals.get(projectKey) || 0) + value);
      });
    }

    // Sort by raw values to establish initial order
    const sortedProjects = Array.from(rawProjectTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([project]) => project);

    // Now calculate filtered values for these projects
    if (selectedMetric === 'active_users') {
      const projectUsers = new Map<string, Set<string>>();
      filteredTimeseriesData.forEach(point => {
        const projectKey = point.projectId ?? 'No Project';
        if (sortedProjects.includes(projectKey) && point.requestCount > 0) {
          if (!projectUsers.has(projectKey)) {
            projectUsers.set(projectKey, new Set());
          }
          projectUsers.get(projectKey)?.add(point.email);
        }
      });

      const projectValues = sortedProjects.map(project => ({
        project,
        value: projectUsers.get(project)?.size || 0,
        rawValue: rawProjectTotals.get(project) || 0,
      }));

      // Separate active and ghost items
      const activeItems = projectValues.filter(item => item.value > 0);
      const ghostItems = projectValues.filter(item => item.value === 0);

      // Sort active items by filtered value, ghost items maintain raw order
      activeItems.sort((a, b) => b.value - a.value);

      const sortedValues = [...activeItems, ...ghostItems];
      const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

      return sortedValues.map(({ project, value }) => ({
        label: project,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    if (selectedMetric === 'avg_cost_per_req') {
      const projectCosts = new Map<string, number>();
      const projectRequests = new Map<string, number>();
      filteredTimeseriesData.forEach(point => {
        const projectKey = point.projectId ?? 'No Project';
        if (sortedProjects.includes(projectKey)) {
          const cost = point.costMicrodollars || 0;
          const requests = point.requestCount || 0;
          projectCosts.set(projectKey, (projectCosts.get(projectKey) || 0) + cost);
          projectRequests.set(projectKey, (projectRequests.get(projectKey) || 0) + requests);
        }
      });

      const projectValues = sortedProjects.map(project => {
        const cost = projectCosts.get(project) || 0;
        const requests = projectRequests.get(project) || 0;
        const rawValue = rawProjectTotals.get(project) || 0;
        return {
          project,
          value: requests > 0 ? cost / requests : 0,
          rawValue,
        };
      });

      // Separate active and ghost items
      const activeItems = projectValues.filter(item => item.value > 0);
      const ghostItems = projectValues.filter(item => item.value === 0);

      // Sort active items by filtered value, ghost items maintain raw order
      activeItems.sort((a, b) => b.value - a.value);

      const sortedValues = [...activeItems, ...ghostItems];
      const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

      return sortedValues.map(({ project, value }) => ({
        label: project,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    // For other metrics
    const projectTotals = new Map<string, number>();
    filteredTimeseriesData.forEach(point => {
      const projectKey = point.projectId ?? 'No Project';
      if (sortedProjects.includes(projectKey)) {
        const value = getMetricValue(point, selectedMetric);
        projectTotals.set(projectKey, (projectTotals.get(projectKey) || 0) + value);
      }
    });

    const projectValues = sortedProjects.map(project => ({
      project,
      value: projectTotals.get(project) || 0,
      rawValue: rawProjectTotals.get(project) || 0,
    }));

    // Separate active and ghost items
    const activeItems = projectValues.filter(item => item.value > 0);
    const ghostItems = projectValues.filter(item => item.value === 0);

    // Sort active items by filtered value, ghost items maintain raw order
    activeItems.sort((a, b) => b.value - a.value);

    const sortedValues = [...activeItems, ...ghostItems];
    const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

    return sortedValues.map(({ project, value }) => ({
      label: project,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }));
  }, [timeseriesData, filteredTimeseriesData, selectedMetric]);

  // Calculate filter card data for models
  const modelsData = useMemo((): FilterCardItem[] => {
    // Calculate raw values for initial sorting
    const rawModelTotals = new Map<string, number>();

    if (selectedMetric === 'active_users') {
      const rawModelUsers = new Map<string, Set<string>>();
      timeseriesData.forEach(point => {
        if (point.requestCount > 0) {
          if (!rawModelUsers.has(point.model)) {
            rawModelUsers.set(point.model, new Set());
          }
          rawModelUsers.get(point.model)?.add(point.email);
        }
      });
      rawModelUsers.forEach((users, model) => {
        rawModelTotals.set(model, users.size);
      });
    } else if (selectedMetric === 'avg_cost_per_req') {
      const rawModelCosts = new Map<string, number>();
      const rawModelRequests = new Map<string, number>();
      timeseriesData.forEach(point => {
        const cost = point.costMicrodollars || 0;
        const requests = point.requestCount || 0;
        rawModelCosts.set(point.model, (rawModelCosts.get(point.model) || 0) + cost);
        rawModelRequests.set(point.model, (rawModelRequests.get(point.model) || 0) + requests);
      });
      rawModelCosts.forEach((cost, model) => {
        const requests = rawModelRequests.get(model) || 0;
        rawModelTotals.set(model, requests > 0 ? cost / requests : 0);
      });
    } else {
      timeseriesData.forEach(point => {
        const value = getMetricValue(point, selectedMetric);
        rawModelTotals.set(point.model, (rawModelTotals.get(point.model) || 0) + value);
      });
    }

    // Sort by raw values to establish initial order
    const sortedModels = Array.from(rawModelTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([model]) => model);

    // Now calculate filtered values for these models
    if (selectedMetric === 'active_users') {
      const modelUsers = new Map<string, Set<string>>();
      filteredTimeseriesData.forEach(point => {
        if (sortedModels.includes(point.model) && point.requestCount > 0) {
          if (!modelUsers.has(point.model)) {
            modelUsers.set(point.model, new Set());
          }
          modelUsers.get(point.model)?.add(point.email);
        }
      });

      const modelValues = sortedModels.map(model => ({
        model,
        value: modelUsers.get(model)?.size || 0,
        rawValue: rawModelTotals.get(model) || 0,
      }));

      // Separate active and ghost items
      const activeItems = modelValues.filter(item => item.value > 0);
      const ghostItems = modelValues.filter(item => item.value === 0);

      // Sort active items by filtered value, ghost items maintain raw order
      activeItems.sort((a, b) => b.value - a.value);

      const sortedValues = [...activeItems, ...ghostItems];
      const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

      return sortedValues.map(({ model, value }) => ({
        label: model,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    if (selectedMetric === 'avg_cost_per_req') {
      const modelCosts = new Map<string, number>();
      const modelRequests = new Map<string, number>();
      filteredTimeseriesData.forEach(point => {
        if (sortedModels.includes(point.model)) {
          const cost = point.costMicrodollars || 0;
          const requests = point.requestCount || 0;
          modelCosts.set(point.model, (modelCosts.get(point.model) || 0) + cost);
          modelRequests.set(point.model, (modelRequests.get(point.model) || 0) + requests);
        }
      });

      const modelValues = sortedModels.map(model => {
        const cost = modelCosts.get(model) || 0;
        const requests = modelRequests.get(model) || 0;
        const rawValue = rawModelTotals.get(model) || 0;
        return {
          model,
          value: requests > 0 ? cost / requests : 0,
          rawValue,
        };
      });

      // Separate active and ghost items
      const activeItems = modelValues.filter(item => item.value > 0);
      const ghostItems = modelValues.filter(item => item.value === 0);

      // Sort active items by filtered value, ghost items maintain raw order
      activeItems.sort((a, b) => b.value - a.value);

      const sortedValues = [...activeItems, ...ghostItems];
      const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

      return sortedValues.map(({ model, value }) => ({
        label: model,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    // For other metrics
    const modelTotals = new Map<string, number>();
    filteredTimeseriesData.forEach(point => {
      if (sortedModels.includes(point.model)) {
        const value = getMetricValue(point, selectedMetric);
        modelTotals.set(point.model, (modelTotals.get(point.model) || 0) + value);
      }
    });

    const modelValues = sortedModels.map(model => ({
      model,
      value: modelTotals.get(model) || 0,
      rawValue: rawModelTotals.get(model) || 0,
    }));

    // Separate active and ghost items
    const activeItems = modelValues.filter(item => item.value > 0);
    const ghostItems = modelValues.filter(item => item.value === 0);

    // Sort active items by filtered value, ghost items maintain raw order
    activeItems.sort((a, b) => b.value - a.value);

    const sortedValues = [...activeItems, ...ghostItems];
    const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

    return sortedValues.map(({ model, value }) => ({
      label: model,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }));
  }, [timeseriesData, filteredTimeseriesData, selectedMetric]);

  // Don't render if no data is available
  const hasData = timeseriesData && timeseriesData.length > 0;
  if (!hasData) {
    return null;
  }

  // Get full data arrays for modal
  const fullUsersData = useMemo((): FilterCardItem[] => {
    // Calculate raw values for initial sorting
    const rawUserTotals = new Map<string, number>();

    if (selectedMetric === 'avg_cost_per_req') {
      const rawUserCosts = new Map<string, number>();
      const rawUserRequests = new Map<string, number>();

      timeseriesData.forEach(point => {
        const cost = point.costMicrodollars || 0;
        const requests = point.requestCount || 0;
        rawUserCosts.set(point.email, (rawUserCosts.get(point.email) || 0) + cost);
        rawUserRequests.set(point.email, (rawUserRequests.get(point.email) || 0) + requests);
      });

      rawUserCosts.forEach((cost, user) => {
        const requests = rawUserRequests.get(user) || 0;
        rawUserTotals.set(user, requests > 0 ? cost / requests : 0);
      });
    } else {
      timeseriesData.forEach(point => {
        const value = getMetricValue(point, selectedMetric);
        rawUserTotals.set(point.email, (rawUserTotals.get(point.email) || 0) + value);
      });
    }

    // Sort by raw values to establish initial order
    const sortedUsers = Array.from(rawUserTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([user]) => user);

    // Now calculate filtered values for these users
    if (selectedMetric === 'avg_cost_per_req') {
      const userCosts = new Map<string, number>();
      const userRequests = new Map<string, number>();

      filteredTimeseriesData.forEach(point => {
        if (sortedUsers.includes(point.email)) {
          const cost = point.costMicrodollars || 0;
          const requests = point.requestCount || 0;
          userCosts.set(point.email, (userCosts.get(point.email) || 0) + cost);
          userRequests.set(point.email, (userRequests.get(point.email) || 0) + requests);
        }
      });

      const userValues = sortedUsers.map(user => {
        const cost = userCosts.get(user) || 0;
        const requests = userRequests.get(user) || 0;
        const rawValue = rawUserTotals.get(user) || 0;
        return {
          user,
          value: requests > 0 ? cost / requests : 0,
          rawValue,
        };
      });

      // Separate active and ghost items
      const activeItems = userValues.filter(item => item.value > 0);
      const ghostItems = userValues.filter(item => item.value === 0);

      // Sort active items by filtered value, ghost items maintain raw order
      activeItems.sort((a, b) => b.value - a.value);

      const sortedValues = [...activeItems, ...ghostItems];
      const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

      return sortedValues.map(({ user, value }) => ({
        label: user,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    // For other metrics
    const userTotals = new Map<string, number>();

    filteredTimeseriesData.forEach(point => {
      if (sortedUsers.includes(point.email)) {
        const value = getMetricValue(point, selectedMetric);
        userTotals.set(point.email, (userTotals.get(point.email) || 0) + value);
      }
    });

    const userValues = sortedUsers.map(user => ({
      user,
      value: userTotals.get(user) || 0,
      rawValue: rawUserTotals.get(user) || 0,
    }));

    // Separate active and ghost items
    const activeItems = userValues.filter(item => item.value > 0);
    const ghostItems = userValues.filter(item => item.value === 0);

    // Sort active items by filtered value, ghost items maintain raw order
    activeItems.sort((a, b) => b.value - a.value);

    const sortedValues = [...activeItems, ...ghostItems];
    const total = sortedValues.reduce((sum, item) => sum + item.value, 0);

    return sortedValues.map(({ user, value }) => ({
      label: user,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }));
  }, [timeseriesData, filteredTimeseriesData, selectedMetric]);

  const fullModelsData = useMemo((): FilterCardItem[] => {
    // Calculate raw values for initial sorting
    const rawModelTotals = new Map<string, number>();

    if (selectedMetric === 'active_users') {
      const rawModelUsers = new Map<string, Set<string>>();
      timeseriesData.forEach(point => {
        if (point.requestCount > 0) {
          if (!rawModelUsers.has(point.model)) {
            rawModelUsers.set(point.model, new Set());
          }
          rawModelUsers.get(point.model)?.add(point.email);
        }
      });
      rawModelUsers.forEach((users, model) => {
        rawModelTotals.set(model, users.size);
      });
    } else if (selectedMetric === 'avg_cost_per_req') {
      const rawModelCosts = new Map<string, number>();
      const rawModelRequests = new Map<string, number>();
      timeseriesData.forEach(point => {
        const cost = point.costMicrodollars || 0;
        const requests = point.requestCount || 0;
        rawModelCosts.set(point.model, (rawModelCosts.get(point.model) || 0) + cost);
        rawModelRequests.set(point.model, (rawModelRequests.get(point.model) || 0) + requests);
      });
      rawModelCosts.forEach((cost, model) => {
        const requests = rawModelRequests.get(model) || 0;
        rawModelTotals.set(model, requests > 0 ? cost / requests : 0);
      });
    } else {
      timeseriesData.forEach(point => {
        const value = getMetricValue(point, selectedMetric);
        rawModelTotals.set(point.model, (rawModelTotals.get(point.model) || 0) + value);
      });
    }

    // Sort by raw values to establish initial order
    const sortedModels = Array.from(rawModelTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model);

    // Now calculate filtered values for these models
    if (selectedMetric === 'active_users') {
      const modelUsers = new Map<string, Set<string>>();
      filteredTimeseriesData.forEach(point => {
        if (sortedModels.includes(point.model) && point.requestCount > 0) {
          if (!modelUsers.has(point.model)) {
            modelUsers.set(point.model, new Set());
          }
          modelUsers.get(point.model)?.add(point.email);
        }
      });

      const modelValues = sortedModels.map(model => ({
        model,
        value: modelUsers.get(model)?.size || 0,
      }));

      const total = modelValues.reduce((sum, item) => sum + item.value, 0);

      return modelValues.map(({ model, value }) => ({
        label: model,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    if (selectedMetric === 'avg_cost_per_req') {
      const modelCosts = new Map<string, number>();
      const modelRequests = new Map<string, number>();
      filteredTimeseriesData.forEach(point => {
        if (sortedModels.includes(point.model)) {
          const cost = point.costMicrodollars || 0;
          const requests = point.requestCount || 0;
          modelCosts.set(point.model, (modelCosts.get(point.model) || 0) + cost);
          modelRequests.set(point.model, (modelRequests.get(point.model) || 0) + requests);
        }
      });

      const modelValues = sortedModels.map(model => {
        const cost = modelCosts.get(model) || 0;
        const requests = modelRequests.get(model) || 0;
        return {
          model,
          value: requests > 0 ? cost / requests : 0,
        };
      });

      const total = modelValues.reduce((sum, item) => sum + item.value, 0);

      return modelValues.map(({ model, value }) => ({
        label: model,
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
      }));
    }

    // For other metrics
    const modelTotals = new Map<string, number>();
    filteredTimeseriesData.forEach(point => {
      if (sortedModels.includes(point.model)) {
        const value = getMetricValue(point, selectedMetric);
        modelTotals.set(point.model, (modelTotals.get(point.model) || 0) + value);
      }
    });

    const modelValues = sortedModels.map(model => ({
      model,
      value: modelTotals.get(model) || 0,
    }));

    const total = modelValues.reduce((sum, item) => sum + item.value, 0);

    return modelValues.map(({ model, value }) => ({
      label: model,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }));
  }, [timeseriesData, filteredTimeseriesData, selectedMetric]);

  const handleShowAll = (subType: 'user' | 'project' | 'model') => {
    let items: FilterCardItem[];
    let title: string;

    switch (subType) {
      case 'user':
        items = fullUsersData;
        title = 'Users';
        break;
      case 'project':
        items = projectsData;
        title = 'Projects';
        break;
      case 'model':
        items = fullModelsData;
        title = 'Models';
        break;
    }

    setModalState({
      isOpen: true,
      title,
      items,
      subType,
    });
  };

  const handleCloseModal = () => {
    setModalState(prev => ({ ...prev, isOpen: false }));
  };

  return (
    <div className={`space-y-6 ${className}`}>
      <div>
        <h3 className="mb-4 text-lg font-semibold text-gray-100">Usage Breakdown</h3>
        <div
          className={`grid grid-cols-1 gap-6 ${selectedMetric === 'active_users' ? 'lg:grid-cols-2' : 'lg:grid-cols-3'}`}
        >
          {selectedMetric !== 'active_users' && (
            <FilterCard
              title="Users"
              items={usersData}
              selectedMetric={selectedMetric}
              activeFilters={activeFilters.filter(f => f.subType === 'user')}
              onFilter={item => onFilter?.('user', item.label)}
              onExclude={item => onExclude?.('user', item.label)}
              onShowAll={() => handleShowAll('user')}
            />
          )}

          <FilterCard
            title="Projects"
            items={projectsData}
            selectedMetric={selectedMetric}
            activeFilters={activeFilters.filter(f => f.subType === 'project')}
            onFilter={item => onFilter?.('project', item.label)}
            onExclude={item => onExclude?.('project', item.label)}
            onShowAll={() => handleShowAll('project')}
            titleTooltip="Project tracking is a new feature and not all project data has been tracked"
          />

          <FilterCard
            title="Models"
            items={modelsData}
            selectedMetric={selectedMetric}
            activeFilters={activeFilters.filter(f => f.subType === 'model')}
            onFilter={item => onFilter?.('model', item.label)}
            onExclude={item => onExclude?.('model', item.label)}
            onShowAll={() => handleShowAll('model')}
          />
        </div>
      </div>

      <FilterModal
        isOpen={modalState.isOpen}
        onClose={handleCloseModal}
        title={modalState.title}
        items={modalState.items}
        selectedMetric={selectedMetric}
        activeFilters={activeFilters.filter(f => f.subType === modalState.subType)}
        onFilter={item => onFilter?.(modalState.subType, item.label)}
        onExclude={item => onExclude?.(modalState.subType, item.label)}
      />
    </div>
  );
}
