import { Response, Request } from "express";
import { services } from "../../../../services/services";
import { extractFiles, solc } from "../../verification.common";
import { checkFiles, useAllSources } from "@ethereum-sourcify/lib-sourcify";
import { BadRequestError, ValidationError } from "../../../../../common/errors";
import { getResponseMatchFromMatch } from "../../../../common";
import { getAllMetadataAndSourcesFromSolcJson } from "../../../../services/compiler/local/solidityCompiler";

export async function verifySolcJsonEndpoint(req: Request, res: Response) {
  const inputFiles = extractFiles(req, true);
  if (!inputFiles) throw new ValidationError("No files found");
  if (inputFiles.length !== 1)
    throw new BadRequestError(
      "Only one Solidity JSON Input file at a time is allowed"
    );

  let solcJson;
  try {
    solcJson = JSON.parse(inputFiles[0].buffer.toString());
  } catch (error: any) {
    throw new BadRequestError(
      `Couldn't parse JSON ${inputFiles[0].path}. Make sure the contents of the file are syntaxed correctly.`
    );
  }
  const compilerVersion = req.body.compilerVersion;
  const contractName = req.body.contractName;
  const chain = req.body.chain;
  const address = req.body.address;

  const metadataAndSourcesPathBuffers =
    await getAllMetadataAndSourcesFromSolcJson(solcJson, compilerVersion);

  const checkedContracts = await checkFiles(
    solc,
    metadataAndSourcesPathBuffers
  );
  const contractToVerify = checkedContracts.find(
    (c) => c.name === contractName
  );
  if (!contractToVerify) {
    throw new BadRequestError(
      `Couldn't find contract ${contractName} in the provided Solidity JSON Input file.`
    );
  }

  const match = await services.verification.verifyDeployed(
    contractToVerify,
    chain,
    address,
    // req.body.contextVariables,
    req.body.creatorTxHash
  );
  // Send to verification again with all source files.
  if (match.runtimeMatch === "extra-file-input-bug") {
    const contractWithAllSources = await useAllSources(
      contractToVerify,
      metadataAndSourcesPathBuffers
    );
    const tempMatch = await services.verification.verifyDeployed(
      contractWithAllSources,
      chain,
      address, // Due to the old API taking an array of addresses.
      // req.body.contextVariables,
      req.body.creatorTxHash
    );
    if (
      tempMatch.runtimeMatch === "perfect" ||
      tempMatch.creationMatch === "perfect"
    ) {
      await services.storage.storeMatch(contractToVerify, tempMatch);
      return res.send({ result: [tempMatch] });
    } else if (tempMatch.runtimeMatch === "extra-file-input-bug") {
      throw new ValidationError(
        "It seems your contract's metadata hashes match but not the bytecodes. You should add all the files input to the compiler during compilation and remove all others. See the issue for more information: https://github.com/ethereum/sourcify/issues/618"
      );
    }
  }
  if (match.runtimeMatch || match.creationMatch) {
    await services.storage.storeMatch(contractToVerify, match);
  }
  return res.send({ result: [getResponseMatchFromMatch(match)] }); // array is an old expected behavior (e.g. by frontend)
}
