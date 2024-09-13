import { omnidoraLight, omnidoraDark } from '~/renderer/constants/themes';

export const getTheme = (name: string) => {
  if (name === 'socrathink-light') return omnidoraLight;
  else if (name === 'socrathink-dark') return omnidoraDark;
  return omnidoraDark;
};
