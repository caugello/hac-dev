import { applicationDetailPagePO } from '../support/pageObjects/createApplication-po';
import { ApplicationDetailPage } from '../support/pages/ApplicationDetailPage';
import { ComponentPage } from '../support/pages/ComponentsPage';
import { IntegrationTestsTabPage } from '../support/pages/tabs/IntegrationTestsTabPage';
import { LatestCommitsTabPage } from '../support/pages/tabs/LatestCommitsTabPage';
import {
  DetailsTab,
  LogsTab,
  PipelinerunsTabPage,
  TaskRunsTab,
} from '../support/pages/tabs/PipelinerunsTabPage';
import { Applications } from '../utils/Applications';
import { Common } from '../utils/Common';
import { UIhelper } from '../utils/UIhelper';
import { APIHelper } from '../utils/APIHelper';
import { githubAPIEndpoints } from '../utils/APIEndpoints';

describe('Advanced Happy path', () => {
  const applicationName = Common.generateAppName();
  const applicationDetailPage = new ApplicationDetailPage();
  const componentPage = new ComponentPage();
  const latestCommitsTabPage = new LatestCommitsTabPage();
  const integrationTestsTabPage = new IntegrationTestsTabPage();
  const sourceCodeRepoLink = 'https://github.com/hac-test/devfile-sample-go-basic';
  const repoName = Common.generateAppName('devfile-sample-go-basic');
  const repoOwner = 'redhat-hac-qe';
  const repoLink = `https://github.com/${repoOwner}/${repoName}`;
  const gitHubUser = Cypress.env('GH_USERNAME');
  const componentName = Common.generateAppName('go');

  after(function () {
    APIHelper.deleteGitHubRepository(repoName);

    // If some test failed, don't remove the app
    let allTestsSucceeded = true;
    this.test.parent.eachTest((test) => {
      if (test.state == 'failed') {
        allTestsSucceeded = false;
      }
    });
    if (allTestsSucceeded || Cypress.env('REMOVE_APP_ON_FAIL')) {
      Applications.deleteApplication(applicationName);
    }
  });

  const componentInfo: { [key: string]: string } = {
    deploymentBodyOriginal: 'Hello World!',
    deploymentBodyUpdated: 'Bye World!',
    filePath: 'main.go',
    firstCommitTitle: 'firstCommit',
    firstCommitMessage: 'This PR was auto-generated by appstudio-ci__bot',
    updatedCommitMessage: 'secondCommit',
  };

  const integrationTestDetails: { [key: string]: string } = {
    integrationTestName: Common.generateAppName('integration-tests'),
    integrationTestNameTemp: Common.generateAppName('integration-tests-temp'),
    githubURL: 'https://github.com/redhat-appstudio/integration-examples',
    pathInRepository: 'pipelines/integration_pipeline_pass.yaml',
  };

  const integrationTestTaskNames = ['task-success', 'task-success-2', 'task-skipped'];
  const vulnerabilities = /Critical(\d+).*High(\d+).*Medium(\d+).*Low(\d+)/g;
  const secret = {
    secretName: Common.generateAppName('secret'),
    key: 'secretKey',
    value: 'secretValue',
  };

  before(() => {
    APIHelper.createGitHubRepository(repoName);
    APIHelper.importCodeToGitHubRepository(sourceCodeRepoLink, repoName);
    APIHelper.githubRequest(
      'GET',
      githubAPIEndpoints.contents('hac-test', 'devfile-sample-go-basic', componentInfo.filePath),
    ).then((response) => {
      componentInfo.goFileSHAOriginal = response.body.sha;
      componentInfo.goFileBase64Original = response.body.content;
    });
  });

  it('Create an Application with a component', () => {
    Applications.createApplication();
    Applications.createComponent(
      repoLink,
      componentName,
      applicationName,
      'Go',
      true,
      {
        varName: 'TEST_ENV_VAR',
        value: 'Test go app',
      },
      secret,
    );
  });

  describe('Trigger a new Pipelinerun related to push event', () => {
    it('Merge the auto-generated PR, and verify the event status on modal', () => {
      componentPage.verifyAndWaitForPRIsSent();

      latestCommitsTabPage.mergePR(
        repoOwner,
        repoName,
        1,
        componentInfo.firstCommitTitle,
        componentInfo.firstCommitMessage,
      );

      componentPage.verifyAndWaitForPRMerge();
      componentPage.closeModal();
    });

    it('Validate the component', () => {
      Applications.checkComponentInListView(
        componentName,
        applicationName,
        'Build Running',
        'Custom',
      );
    });

    it('Verify Secret Using API', () => {
      Applications.verifySecretUsingAPI(secret.secretName, secret.key, secret.value);
    });

    it('Verify the Pipeline run details and Task runs', () => {
      Applications.goToPipelinerunsTab();
      cy.contains(`${componentName}-on-push`)
        .invoke('text')
        .then((pipelinerunName) => {
          componentInfo.firstPipelineRunName = pipelinerunName;
          UIhelper.clickLink(componentInfo.firstPipelineRunName);
          DetailsTab.waitUntilStatusIsNotRunning();
          LogsTab.downloadAllTaskLogs();
          UIhelper.verifyLabelAndValue('Status', 'Succeeded');

          TaskRunsTab.goToTaskrunsTab();
          TaskRunsTab.assertTaskNamesAndTaskRunStatus(
            TaskRunsTab.getAdvancedTaskNamesList(componentInfo.firstPipelineRunName),
          );
        });
    });
  });

  describe('Verify SBOM on pipeline run details', () => {
    it('Verify SBOM and logs', () => {
      UIhelper.clickTab('Details');
      DetailsTab.checkDownloadSBOM();
      UIhelper.clickLink('View SBOM');
      DetailsTab.verifyLogs('"bomFormat": "CycloneDX"');
    });

    it('Execute and validate using Cosign', () => {
      Applications.clickBreadcrumbLink(componentInfo.firstPipelineRunName);
      DetailsTab.downloadSBOMAndCheckUsingCosign();
    });
  });

  describe('Verify CVE scan', () => {
    it('Verify clair scan node details on drawer Panel', () => {
      DetailsTab.clickOnNode('clair-scan');
      DetailsTab.checkVulScanOnClairDrawer(vulnerabilities);
      DetailsTab.checkNodeDrawerPanelResult('TEST_OUTPUT', '"result":"SUCCESS"');
      DetailsTab.clickOnDrawerPanelLogsTab();
      DetailsTab.verifyLogs('Task clair-scan completed');
      DetailsTab.closeDrawerPanel();
    });

    it('Verify vulnebralities on pipeline run Details Page', () => {
      DetailsTab.checkVulScanOnPipelinerunDetails(vulnerabilities);
      DetailsTab.clickOnVulScanViewLogs();
      DetailsTab.verifyLogs('Task clair-scan completed');
    });

    it('Verify vulnebralities on pipeline run list', () => {
      Applications.clickBreadcrumbLink('Pipeline runs');
      UIhelper.getTableRow('Pipeline run List', componentInfo.firstPipelineRunName).within(() => {
        cy.contains(vulnerabilities).should('be.visible');
      });
    });
  });
  describe('Check Component Deployment', () => {
    it('Verify the status code and response body of the deployment URL of each component', () => {
      Applications.goToComponentsTab();
      applicationDetailPage.expandDetails(componentName);

      cy.get(applicationDetailPagePO.route(componentName), { timeout: 240000 })
        .invoke('text')
        .then((route) => {
          APIHelper.checkResponseBodyAndStatusCode(
            route,
            componentInfo.deploymentBodyOriginal,
            5000,
          );
        });

      Applications.checkComponentStatus(componentName, 'Build Succeeded');
    });

    it('Verify SBOM on components tab', () => {
      DetailsTab.checkDownloadSBOM();
    });
  });

  describe('Add and edit integration test', () => {
    it('Add integration test and verify', () => {
      UIhelper.clickTab('Integration tests');
      integrationTestsTabPage.clickOnAddIntegrationTestBtn();
      integrationTestsTabPage.addIntegrationTest(
        integrationTestDetails.integrationTestName,
        integrationTestDetails.githubURL,
        'main',
        integrationTestDetails.pathInRepository,
        'check',
      );
      integrationTestsTabPage.verifyRowInIntegrationTestsTable({
        name: integrationTestDetails.integrationTestName,
        githubURL: integrationTestDetails.githubURL,
        optionalForRelease: 'Optional',
        revision: 'main',
      });
    });

    it('Add integration test from Actions and verify', () => {
      Applications.clickActionsDropdown('Add integration test');
      integrationTestsTabPage.addIntegrationTest(
        integrationTestDetails.integrationTestNameTemp,
        integrationTestDetails.githubURL,
        'main',
        integrationTestDetails.pathInRepository,
      );
      integrationTestsTabPage.verifyRowInIntegrationTestsTable({
        name: integrationTestDetails.integrationTestNameTemp,
        githubURL: integrationTestDetails.githubURL,
        optionalForRelease: 'Mandatory',
        revision: 'main',
      });
    });

    it('Edit integration test and verify', () => {
      integrationTestsTabPage.openAndClickKebabMenu(
        integrationTestDetails.integrationTestName,
        'Edit',
      );
      Common.waitForLoad();
      integrationTestsTabPage.editIntegrationTest(integrationTestDetails.githubURL, 'uncheck');
      integrationTestsTabPage.verifyRowInIntegrationTestsTable({
        name: integrationTestDetails.integrationTestName,
        githubURL: integrationTestDetails.githubURL,
        optionalForRelease: 'Mandatory',
        revision: 'main',
      });
    });

    it('Delete one of integration test and verify', () => {
      UIhelper.clickLink(integrationTestDetails.integrationTestNameTemp);
      integrationTestsTabPage.deleteIntegrationTestFromActions();
      Common.waitForLoad();
      cy.contains(integrationTestDetails.integrationTestNameTemp).should('not.exist');
    });
  });

  describe('Add a new commit and verify Build Pipeline run', () => {
    it('Add a new commit with changes to a file', () => {
      const goFileUpdated = Buffer.from(componentInfo.goFileBase64Original, 'base64')
        .toString('utf8')
        .replace(componentInfo.deploymentBodyOriginal, componentInfo.deploymentBodyUpdated);

      latestCommitsTabPage.editFile(
        repoLink,
        componentInfo.filePath,
        componentInfo.updatedCommitMessage,
        Buffer.from(goFileUpdated).toString('base64'),
        componentInfo.goFileSHAOriginal,
      );
    });

    it('Verify and wait for the new Pipeline run', () => {
      Applications.goToPipelinerunsTab();
      UIhelper.getTableRow('Pipeline run List', /Running|Pending/)
        .contains(`${componentName}-on-push`)
        .invoke('text')
        .then((pipelinerunName) => {
          componentInfo.secondPipelineRunName = pipelinerunName;
          UIhelper.clickLink(componentInfo.secondPipelineRunName);
          DetailsTab.waitUntilStatusIsNotRunning();
          LogsTab.downloadAllTaskLogs();
          UIhelper.verifyLabelAndValue('Status', 'Succeeded');

          TaskRunsTab.goToTaskrunsTab();
          TaskRunsTab.assertTaskNamesAndTaskRunStatus(
            TaskRunsTab.getAdvancedTaskNamesList(componentInfo.secondPipelineRunName),
          );
        });
    });
  });

  describe('Verify Integration Test Pipeline Runs on Activity Tab', () => {
    it('Verify Integration Test pipeline run Details', () => {
      Applications.clickBreadcrumbLink('Pipeline runs');
      PipelinerunsTabPage.getPipelineRunNameByLabel(
        applicationName,
        `test.appstudio.openshift.io/scenario=${integrationTestDetails.integrationTestName}`,
      ).then((testPipelineName) => {
        integrationTestDetails.passIntegrationTestPipelineRunName = testPipelineName;
        UIhelper.verifyRowInTable('Pipeline run List', testPipelineName, [/^Test$/]);
        UIhelper.clickLink(testPipelineName);
      });
      DetailsTab.waitUntilStatusIsNotRunning();
      LogsTab.downloadAllTaskLogs();
      UIhelper.verifyLabelAndValue('Status', 'Succeeded');
      UIhelper.verifyLabelAndValue('Related pipelines', '2 pipelines').click();
      PipelinerunsTabPage.verifyRelatedPipelines(componentInfo.secondPipelineRunName);
    });

    it('Verify Integration Test pipeline run graph', () => {
      UIhelper.verifyGraphNodes(integrationTestTaskNames[0]);
      UIhelper.verifyGraphNodes(integrationTestTaskNames[1]);
      UIhelper.verifyGraphNodes(integrationTestTaskNames[2], false);
    });

    it('Verify Integration Test pipeline runs Task runs & Logs Tab', () => {
      UIhelper.clickTab('Task runs');
      TaskRunsTab.assertTaskNamesAndTaskRunStatus([
        {
          name: new RegExp(`${applicationName}-.*-${integrationTestTaskNames[0]}`),
          task: 'test-output',
          status: 'Succeeded',
        },
        {
          name: new RegExp(`${applicationName}-.*-${integrationTestTaskNames[1]}`),
          task: 'test-output',
          status: 'Succeeded',
        },
      ]);
      UIhelper.clickTab('Logs');
      applicationDetailPage.verifyBuildLogTaskslist(integrationTestTaskNames);
    });
  });

  describe('Verify Enterprise Contract Integration Test Pipeline Runs on Activity Tab', () => {
    it('Verify EC Integration Test pipeline run Details', () => {
      Applications.clickBreadcrumbLink('Pipeline runs');
      PipelinerunsTabPage.getPipelineRunNameByLabel(
        applicationName,
        `test.appstudio.openshift.io/scenario=${applicationName}-enterprise-contract`,
        {
          key: 'pac.test.appstudio.openshift.io/sha-title',
          value: componentInfo.updatedCommitMessage,
        },
      ).then((testPipelineName) => {
        integrationTestDetails.enterpriseContractITPipelineRunName = testPipelineName;
        UIhelper.verifyRowInTable('Pipeline run List', testPipelineName, [/^Test$/]);
        UIhelper.clickLink(testPipelineName);
        DetailsTab.waitUntilStatusIsNotRunning();
        LogsTab.downloadAllTaskLogs(false);
        UIhelper.verifyLabelAndValue('Status', 'Succeeded');
        UIhelper.verifyLabelAndValue('Pipeline', testPipelineName);
        UIhelper.verifyLabelAndValue('Related pipelines', '2 pipelines').click();
        PipelinerunsTabPage.verifyRelatedPipelines(
          integrationTestDetails.passIntegrationTestPipelineRunName,
        );
      });
    });

    it('Verify EC Integration Test pipeline runs Logs Tab', () => {
      UIhelper.clickTab('Logs');
      DetailsTab.verifyLogs('"result": "SUCCESS"');
    });

    it('Verify EC Integration Test pipeline runs Security Tab', () => {
      UIhelper.clickTab('Security');
      PipelinerunsTabPage.verifyECSecurityRulesResultSummary(
        /Failed(\d+).*Warning(\d+).*Success(\d+)/g,
      );
      PipelinerunsTabPage.verifyECSecurityRules('Attestation signature check passed', {
        rule: 'Attestation signature check passed',
        status: 'Success',
        message: '-',
      });
    });
  });

  describe('Verify Integration Test Details on Integration tests Tab', () => {
    it('Verify Integration Tests Overview page', () => {
      Applications.clickBreadcrumbLink(applicationName);
      UIhelper.clickTab('Integration tests');
      UIhelper.clickLink(integrationTestDetails.integrationTestName);
      UIhelper.verifyLabelAndValue('Name', integrationTestDetails.integrationTestName);
      UIhelper.verifyLabelAndValue('GitHub URL', integrationTestDetails.githubURL);
      UIhelper.verifyLabelAndValue('Path in repository', integrationTestDetails.pathInRepository);
      UIhelper.verifyLabelAndValue('Optional for release', 'Mandatory');
    });

    it('Verify Integration Tests Pipeline runs page', () => {
      UIhelper.clickTab('Pipeline runs');
      UIhelper.verifyRowInTable('Pipeline run List', `${applicationName}-`, [
        /Succeeded/,
        /^Test$/,
      ]);
    });
  });

  describe('Verify new commit updates in Components Tab', () => {
    it('Verify that the component deployment reflects latest changes', () => {
      Applications.clickBreadcrumbLink(applicationName);
      Applications.goToComponentsTab();

      applicationDetailPage.expandDetails(componentName);

      cy.get(applicationDetailPagePO.route(componentName), { timeout: 240000 })
        .invoke('text')
        .then((route) => {
          APIHelper.checkResponseBodyAndStatusCode(
            route,
            componentInfo.deploymentBodyUpdated,
            20000,
            0,
            20,
          );
        });

      Applications.checkComponentStatus(componentName, 'Build Succeeded');
    });

    it('Verify view pod logs', () => {
      applicationDetailPage.openPodLogs(componentName);
      cy.contains('Pod status: Running').should('be.visible');
      applicationDetailPage.checkPodLog('my-go', 'TEST_ENV_VAR : Test go app');
      applicationDetailPage.closeBuildLog();
    });
  });

  describe('Verify Latest commits and Pipeline runs in Activity Tab', () => {
    it('Verify the Commits List view should have both the commits', () => {
      Applications.goToLatestCommitsTab();
      UIhelper.verifyRowInTable('Commit List', componentInfo.firstCommitTitle, [
        'main',
        componentName,
        gitHubUser,
        'Succeeded',
      ]);
      UIhelper.verifyRowInTable('Commit List', componentInfo.updatedCommitMessage, [
        'main',
        componentName,
        gitHubUser,
        'Succeeded',
      ]);
    });

    it('Verify the Commit Overview Tab of the Last Commit', () => {
      latestCommitsTabPage.clickOnCommit(componentInfo.updatedCommitMessage);
      latestCommitsTabPage.verifyCommitsPageTitleAndStatus(componentInfo.updatedCommitMessage);
      latestCommitsTabPage.verifyCommitID(
        Cypress.env(`${componentInfo.updatedCommitMessage}_SHA`),
        repoLink,
      ); // Commit SHA was stored in dynamic env at latestCommitsTabPage.editFile()
      latestCommitsTabPage.verifyBranch('main', repoLink);
      UIhelper.verifyLabelAndValue('By', gitHubUser);
      UIhelper.verifyLabelAndValue('Status', 'Succeeded');
      latestCommitsTabPage.verifyNodesOnCommitOverview([
        'commit',
        `${componentName}-build`,
        'development',
      ]);
    });

    it('verify the Commit Pipeline runs Tab', () => {
      UIhelper.clickTab('Pipeline runs');
      UIhelper.verifyRowInTable(
        'Pipelinerun List',
        integrationTestDetails.enterpriseContractITPipelineRunName,
        ['Succeeded', 'Test'],
      );
      UIhelper.verifyRowInTable(
        'Pipelinerun List',
        integrationTestDetails.passIntegrationTestPipelineRunName,
        ['Succeeded', 'Test'],
      );
      UIhelper.verifyRowInTable('Pipelinerun List', componentInfo.secondPipelineRunName, [
        'Succeeded',
        'Build',
      ]);
    });
  });

  describe('Verify application Lifecycle nodes on Overview page', () => {
    it('check Lifecycle Nodes', () => {
      Applications.clickBreadcrumbLink(applicationName);
      Common.waitForLoad();
      UIhelper.verifyGraphNodes('Components', false);
      UIhelper.verifyGraphNodes('Builds');
      UIhelper.verifyGraphNodes('Tests', false);
      UIhelper.verifyGraphNodes('Static environments');
    });
  });

  describe('Verify the Latest Commits section on application overview page', () => {
    it('Verify the Commits List view should have both the commits', () => {
      Applications.goToOverviewTab();
      UIhelper.verifyRowInTable('Commit List', componentInfo.firstCommitTitle, [
        'main',
        componentName,
        gitHubUser,
        'Succeeded',
      ]);
      UIhelper.verifyRowInTable('Commit List', componentInfo.updatedCommitMessage, [
        'main',
        componentName,
        gitHubUser,
        'Succeeded',
      ]);
    });

    it('Verify the Commit Overview Tab of the Last Commit', () => {
      latestCommitsTabPage.clickOnCommit(componentInfo.updatedCommitMessage);
      latestCommitsTabPage.verifyCommitsPageTitleAndStatus(componentInfo.updatedCommitMessage);
      latestCommitsTabPage.verifyCommitID(
        Cypress.env(`${componentInfo.updatedCommitMessage}_SHA`),
        repoLink,
      );
      latestCommitsTabPage.verifyBranch('main', repoLink);
      latestCommitsTabPage.verifyNodesOnCommitOverview([
        'commit',
        `${componentName}-build`,
        'development',
      ]);
    });

    it('verify the Commit Pipeline runs Tab', () => {
      UIhelper.clickTab('Pipeline runs');
      UIhelper.verifyRowInTable('Pipelinerun List', componentInfo.secondPipelineRunName, [
        'Succeeded',
        'Build',
      ]);
    });
  });
});
