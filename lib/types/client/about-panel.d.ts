export interface AboutPanelProps {
    repositoryUrl: string;
    version: string;
    license: string;
    compatibleVersions: string;
    onCheckUpdate?: () => void;
    starUrl?: string;
}
export declare function AboutPanel({ repositoryUrl, version, license, compatibleVersions, onCheckUpdate, starUrl }: AboutPanelProps): import("react").JSX.Element;
