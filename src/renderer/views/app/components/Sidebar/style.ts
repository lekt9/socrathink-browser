import styled from 'styled-components';

export const SidebarContainer = styled.div`
  width: 350px;
  height: 100vh;
  position: fixed;
  top: 0;
  right: 0;
  border-left: 1px solid #ccc;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  @media (max-width: 768px) {
    width: 100%;
    height: 50vh;
    bottom: 0;
    top: auto;
    border-left: none;
    border-top: 1px solid #ccc;
  }
`;

export const ResponsiveIframe = styled.iframe`
  width: 100%;
  height: 100%;
  border: none;
`;